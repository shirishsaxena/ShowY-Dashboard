"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const vm = require("node:vm");
const { describeConfigChanges } = require("../lib/config-activity");

const service = (id = "plex", name = "Plex", extra = {}) => ({
  id,
  name,
  icon: "",
  url: "",
  altUrl: "",
  description: "",
  notes: "",
  container: "",
  group: "",
  ...extra,
});
const server = (id = "nas", name = "NAS", services = [], extra = {}) => ({
  id,
  name,
  icon: "",
  mainUrl: "",
  description: "",
  location: "",
  specs: "",
  local: false,
  groups: [],
  services,
  ...extra,
});
const action = (id = "docs", name = "Docs", extra = {}) => ({
  id,
  name,
  type: "link",
  url: "https://example.test",
  text: "",
  icon: "",
  ...extra,
});
const fixture = () => ({
  settings: {
    title: "Home Lab",
    appName: "",
    accent: "",
    hiddenContainers: [],
    favorites: [],
    links: [],
  },
  servers: [server("nas", "NAS", [service()])],
});
const copy = (value) => JSON.parse(JSON.stringify(value));
const titles = (entries) => entries.map((entry) => entry.title);
function edit(mutate, before = fixture()) {
  const after = copy(before);
  mutate(after);
  return describeConfigChanges(before, after);
}
function freeze(value) {
  for (const child of Object.values(value)) {
    if (child && typeof child === "object") freeze(child);
  }
  return Object.freeze(value);
}
function assertShape(entries) {
  assert.ok(Array.isArray(entries));
  assert.ok(entries.length <= 21);
  for (const entry of entries) {
    assert.deepEqual(Object.keys(entry).sort(), ["message", "title"]);
    assert.equal(typeof entry.title, "string");
    assert.equal(typeof entry.message, "string");
    assert.ok(entry.title.length <= 200);
    assert.ok(entry.message.length <= 400);
    assert.doesNotMatch(entry.title + entry.message, /[\p{Cc}\p{Cf}\p{Cs}]/u);
  }
}

test("exports only the synchronous descriptor formatter", () => {
  assert.deepEqual(Object.keys(require("../lib/config-activity")), [
    "describeConfigChanges",
  ]);
  const entries = edit((cfg) =>
    cfg.servers[0].services.push(service("new", "New")),
  );
  assertShape(entries);
});

test("module loads and formats with no imports, I/O globals, or import side effects", () => {
  const source = fs.readFileSync(
    path.join(__dirname, "../lib/config-activity.js"),
    "utf8",
  );
  const sandbox = { module: { exports: {} } };
  vm.runInNewContext(`(function (module) {\n${source}\n})(module);`, sandbox, {
    timeout: 1000,
  });
  assert.deepEqual(Object.keys(sandbox).sort(), ["module"]);
  const before = fixture();
  const after = copy(before);
  after.servers[0].name = "Storage";
  const entries = sandbox.module.exports.describeConfigChanges(before, after);
  assert.deepEqual(copy(entries), [
    {
      title: "Server renamed: “NAS” → “Storage”",
      message: "Server name changed.",
    },
  ]);
});

test("identical normalized documents and object-key-order differences are no-ops", () => {
  const before = fixture();
  assert.deepEqual(describeConfigChanges(before, before), []);
  assert.deepEqual(describeConfigChanges(before, copy(before)), []);
  function reverseKeys(value) {
    if (Array.isArray(value)) return value.map(reverseKeys);
    if (!value || typeof value !== "object") return value;
    return Object.fromEntries(
      Object.entries(value)
        .reverse()
        .map(([key, child]) => [key, reverseKeys(child)]),
    );
  }
  assert.deepEqual(describeConfigChanges(before, reverseKeys(before)), []);
});

test("adds and deletes services with their server context", () => {
  assert.deepEqual(
    edit((cfg) =>
      cfg.servers[0].services.push(service("jellyfin", "Jellyfin")),
    ),
    [
      {
        title: "Service added: “Jellyfin”",
        message: "Server: “NAS”.",
      },
    ],
  );
  assert.deepEqual(
    edit((cfg) => {
      cfg.servers[0].services = [];
    }),
    [
      {
        title: "Service deleted: “Plex”",
        message: "Server: “NAS”.",
      },
    ],
  );
});

test("service edits name only changed field labels and coalesce URL representations", () => {
  const entries = edit((cfg) =>
    Object.assign(cfg.servers[0].services[0], {
      urls: [{ label: "Private label", url: "https://private.test" }],
      url: "https://private.test",
      altUrl: "https://alternate.test",
      notes: "private notes",
      icon: "https://private.test/image",
    }),
  );
  assert.deepEqual(entries, [
    {
      title: "Service updated: “Plex”",
      message: "Server: “NAS”. Changed: URLs, notes, icon.",
    },
  ]);
});

test("service rename preserves old and new names and concurrent field changes", () => {
  assert.deepEqual(
    edit((cfg) =>
      Object.assign(cfg.servers[0].services[0], {
        name: "Media",
        description: "private",
        type: "web",
        container: "private-container",
      }),
    ),
    [
      {
        title: "Service renamed: “Plex” → “Media”",
        message:
          "Server: “NAS”. Changed: description, container, service type.",
      },
    ],
  );
});

test("a stable service ID moving between servers is not a delete/add", () => {
  const before = fixture();
  before.servers.push(server("mini", "Mini"));
  assert.deepEqual(
    edit((cfg) => {
      cfg.servers[1].services.push(cfg.servers[0].services.pop());
    }, before),
    [
      {
        title: "Service moved: “Plex”",
        message: "From server: “NAS”. To server: “Mini”.",
      },
    ],
  );
});

test("move, rename, and edits are preserved together even when source server is deleted", () => {
  const entries = edit((cfg) => {
    const svc = cfg.servers[0].services[0];
    svc.name = "Media";
    svc.notes = "secret";
    cfg.servers = [server("new", "New NAS", [svc])];
  });
  assert.deepEqual(titles(entries), [
    "Server deleted: “NAS”",
    "Server added: “New NAS”",
    "Service moved: “Media”",
  ]);
  assert.equal(
    entries[2].message,
    "From server: “NAS”. To server: “New NAS”. Renamed: “Plex” → “Media”. Changed: notes.",
  );
});

test("a service group reassignment reports a field label instead of raw values", () => {
  const before = fixture();
  before.servers[0].groups = ["Media", "Tools"];
  before.servers[0].services[0].group = "Media";
  assert.deepEqual(
    edit((cfg) => {
      cfg.servers[0].services[0].group = "Tools";
    }, before),
    [
      {
        title: "Service updated: “Plex”",
        message: "Server: “NAS”. Changed: group.",
      },
    ],
  );
});

test("server additions and deletions summarize nested services without child floods", () => {
  const nested = server(
    "bulk",
    "Bulk",
    Array.from({ length: 100 }, (_, i) => service(`svc-${i}`, `Service ${i}`)),
    { groups: ["Media", "Tools"] },
  );
  assert.deepEqual(
    edit((cfg) => cfg.servers.push(nested)),
    [
      {
        title: "Server added: “Bulk”",
        message: "100 services, 2 groups in the added server.",
      },
    ],
  );
  const before = fixture();
  before.servers = [nested];
  assert.deepEqual(
    edit((cfg) => {
      cfg.servers = [];
    }, before),
    [
      {
        title: "Server deleted: “Bulk”",
        message: "100 services, 2 groups in the removed server.",
      },
    ],
  );
});

test("server updates cover every editable field without its contents", () => {
  assert.deepEqual(
    edit((cfg) =>
      Object.assign(cfg.servers[0], {
        icon: "private-icon",
        mainUrl: "https://private.test",
        description: "private description",
        location: "private location",
        specs: "private specifications",
        local: true,
      }),
    ),
    [
      {
        title: "Server updated: “NAS”",
        message:
          "Changed: icon, main URL, description, location, specifications, local server.",
      },
    ],
  );
});

test("server rename and another update are combined without losing the field label", () => {
  assert.deepEqual(
    edit((cfg) =>
      Object.assign(cfg.servers[0], { name: "Storage", local: true }),
    ),
    [
      {
        title: "Server renamed: “NAS” → “Storage”",
        message: "Server name changed. Changed: local server.",
      },
    ],
  );
});

test("server reordering compares the shared sequence, not shifted indices", () => {
  const before = fixture();
  before.servers.push(server("b", "B"), server("c", "C"));
  assert.deepEqual(
    edit((cfg) => cfg.servers.reverse(), before),
    [
      {
        title: "Servers reordered",
        message: "Server order changed.",
      },
    ],
  );
  assert.deepEqual(
    titles(
      edit((cfg) => {
        cfg.servers.shift();
        cfg.servers.unshift(server("d", "D"));
      }, before),
    ),
    ["Server deleted: “NAS”", "Server added: “D”"],
  );
  assert.ok(
    titles(
      edit((cfg) => {
        cfg.servers.shift();
        cfg.servers.reverse();
        cfg.servers.push(server("d", "D"));
      }, before),
    ).includes("Servers reordered"),
  );
});

test("group add and delete use server names and summarize moves to Ungrouped", () => {
  assert.deepEqual(
    edit((cfg) => cfg.servers[0].groups.push("Media")),
    [
      {
        title: "Group added: “Media”",
        message: "Server: “NAS”.",
      },
    ],
  );
  const before = fixture();
  before.servers[0].groups = ["Media"];
  before.servers[0].services[0].group = "Media";
  assert.deepEqual(
    edit((cfg) => {
      cfg.servers[0].groups = [];
      cfg.servers[0].services[0].group = "";
    }, before),
    [
      {
        title: "Group deleted: “Media”",
        message: "Server: “NAS”. 1 service moved to Ungrouped.",
      },
    ],
  );
});

test("group rename with matching members does not flood unchanged member edits", () => {
  const before = fixture();
  before.servers[0].groups = ["Media", "Tools"];
  before.servers[0].services = Array.from({ length: 40 }, (_, i) =>
    service(`s-${i}`, `Service ${i}`, { group: "Media" }),
  );
  assert.deepEqual(
    edit((cfg) => {
      cfg.servers[0].groups[0] = "Entertainment";
      for (const svc of cfg.servers[0].services) svc.group = "Entertainment";
      cfg.servers[0].services[0].notes = "private note";
    }, before),
    [
      {
        title: "Group renamed: “Media” → “Entertainment”",
        message: "Server: “NAS”.",
      },
      {
        title: "Service updated: “Service 0”",
        message: "Server: “NAS”. Changed: notes.",
      },
    ],
  );
});

test("an empty single same-slot group replacement is inferred as a rename", () => {
  const before = fixture();
  before.servers[0].groups = ["Media", "Tools"];
  assert.deepEqual(
    edit((cfg) => {
      cfg.servers[0].groups[0] = "Entertainment";
    }, before),
    [
      {
        title: "Group renamed: “Media” → “Entertainment”",
        message: "Server: “NAS”.",
      },
    ],
  );
});

test("single group removal/addition with conflicting membership is not called a rename", () => {
  const before = fixture();
  before.servers[0].groups = ["Media"];
  before.servers[0].services[0].group = "Media";
  assert.deepEqual(
    titles(
      edit((cfg) => {
        cfg.servers[0].groups = ["Tools"];
        cfg.servers[0].services[0].group = "";
      }, before),
    ),
    ["Group deleted: “Media”", "Group added: “Tools”"],
  );
});

test("multiple group replacements and changed slots remain additions/deletions", () => {
  const before = fixture();
  before.servers[0].groups = ["A", "B", "C"];
  assert.deepEqual(
    titles(
      edit((cfg) => {
        cfg.servers[0].groups = ["D", "E", "C"];
      }, before),
    ),
    [
      "Group deleted: “A”",
      "Group deleted: “B”",
      "Group added: “D”",
      "Group added: “E”",
    ],
  );
  assert.deepEqual(
    titles(
      edit((cfg) => {
        cfg.servers[0].groups = ["B", "D", "C"];
      }, before),
    ),
    ["Group deleted: “A”", "Group added: “D”"],
  );
});

test("groups reordered compares shared names and ignores insertion/deletion shifts", () => {
  const before = fixture();
  before.servers[0].groups = ["A", "B", "C"];
  assert.deepEqual(
    edit((cfg) => cfg.servers[0].groups.reverse(), before),
    [
      {
        title: "Groups reordered",
        message: "Server: “NAS”.",
      },
    ],
  );
  assert.deepEqual(
    titles(edit((cfg) => cfg.servers[0].groups.unshift("New"), before)),
    ["Group added: “New”"],
  );
  assert.deepEqual(
    titles(edit((cfg) => cfg.servers[0].groups.shift(), before)),
    ["Group deleted: “A”"],
  );
});

test("service reorder ignores additions, removals, and cross-server moves alone", () => {
  const before = fixture();
  before.servers[0].services.push(service("b", "B"), service("c", "C"));
  assert.deepEqual(
    edit((cfg) => cfg.servers[0].services.reverse(), before),
    [
      {
        title: "Services reordered",
        message: "Server: “NAS”.",
      },
    ],
  );
  assert.deepEqual(
    titles(
      edit((cfg) => {
        cfg.servers[0].services.shift();
        cfg.servers[0].services.unshift(service("d", "D"));
      }, before),
    ),
    ["Service deleted: “Plex”", "Service added: “D”"],
  );
  const movedBefore = copy(before);
  movedBefore.servers.push(server("mini", "Mini"));
  assert.deepEqual(
    titles(
      edit((cfg) => {
        cfg.servers[1].services.push(cfg.servers[0].services.shift());
      }, movedBefore),
    ),
    ["Service moved: “Plex”"],
  );
  assert.deepEqual(
    titles(
      edit((cfg) => {
        cfg.servers[0].services.shift();
        cfg.servers[0].services.reverse();
        cfg.servers[0].services.unshift(service("d", "D"));
      }, before),
    ),
    ["Services reordered", "Service deleted: “Plex”", "Service added: “D”"],
  );
});

test("favorites add/remove use service names and reorder uses shared IDs", () => {
  const before = fixture();
  before.servers[0].services.push(service("b", "B"), service("c", "C"));
  before.settings.favorites = ["plex", "b"];
  assert.deepEqual(
    titles(
      edit((cfg) => {
        cfg.settings.favorites = ["b", "c"];
      }, before),
    ),
    ["Favorite removed: “Plex”", "Favorite added: “C”"],
  );
  assert.deepEqual(
    edit((cfg) => cfg.settings.favorites.reverse(), before),
    [
      {
        title: "Favorites reordered",
        message: "Favorite service order changed.",
      },
    ],
  );
});

test("missing favorite IDs never leak identifiers, including deleted services", () => {
  const before = fixture();
  before.settings.favorites = ["plex", "SECRET-FAVORITE-ID"];
  const entries = edit((cfg) => {
    cfg.servers[0].services = [];
    cfg.settings.favorites = [];
  }, before);
  assert.deepEqual(titles(entries), [
    "Service deleted: “Plex”",
    "Favorite removed: “Plex”",
    "Favorite removed: “Unnamed”",
  ]);
  assert.doesNotMatch(JSON.stringify(entries), /SECRET-FAVORITE-ID/);
});

test("quick actions add/update/delete identify names and changed labels only", () => {
  assert.deepEqual(
    edit((cfg) => cfg.settings.links.push(action())),
    [
      {
        title: "Quick action added: “Docs”",
        message: "Quick action created.",
      },
    ],
  );
  const before = fixture();
  before.settings.links = [action()];
  assert.deepEqual(
    edit(
      (cfg) =>
        Object.assign(cfg.settings.links[0], {
          name: "Secret copy",
          type: "copy",
          url: "",
          text: "PRIVATE TEXT",
          icon: "PRIVATE ICON",
        }),
      before,
    ),
    [
      {
        title: "Quick action updated: “Secret copy”",
        message: "Changed: name, action type, URL, copy text, icon.",
      },
    ],
  );
  assert.deepEqual(
    edit((cfg) => {
      cfg.settings.links = [];
    }, before),
    [
      {
        title: "Quick action deleted: “Docs”",
        message: "Quick action removed.",
      },
    ],
  );
});

test("quick action reorder ignores membership shifts but recognizes shared order changes", () => {
  const before = fixture();
  before.settings.links = [
    action("a", "A"),
    action("b", "B"),
    action("c", "C"),
  ];
  assert.deepEqual(
    edit((cfg) => cfg.settings.links.reverse(), before),
    [
      {
        title: "Quick actions reordered",
        message: "Quick action order changed.",
      },
    ],
  );
  assert.deepEqual(
    titles(
      edit((cfg) => {
        cfg.settings.links.shift();
        cfg.settings.links.unshift(action("d", "D"));
      }, before),
    ),
    ["Quick action deleted: “A”", "Quick action added: “D”"],
  );
  assert.ok(
    titles(
      edit((cfg) => {
        cfg.settings.links.shift();
        cfg.settings.links.reverse();
        cfg.settings.links.unshift(action("d", "D"));
      }, before),
    ).includes("Quick actions reordered"),
  );
});

test("hidden/shown containers use counts without exposing stored identifiers", () => {
  const before = fixture();
  before.settings.hiddenContainers = ["SECRET-OLD-CONTAINER"];
  assert.deepEqual(
    edit((cfg) => {
      cfg.settings.hiddenContainers = [
        "SECRET-NEW-CONTAINER",
        "SECRET-SECOND-CONTAINER",
      ];
    }, before),
    [
      {
        title: "Containers hidden",
        message: "2 containers hidden from the dashboard.",
      },
      {
        title: "Container shown",
        message: "1 container shown on the dashboard.",
      },
    ],
  );
});

test("dashboard settings report fixed labels, never their values", () => {
  assert.deepEqual(
    edit((cfg) =>
      Object.assign(cfg.settings, {
        title: "SECRET-TITLE",
        appName: "SECRET-APP",
        accent: "#123456",
      }),
    ),
    [
      {
        title: "Dashboard settings updated",
        message: "Changed: dashboard title, application name, accent color.",
      },
    ],
  );
});

test("unrecognized fields use safe scope labels, not arbitrary keys or payloads", () => {
  const entries = edit(
    (cfg) => {
      cfg["SECRET-ROOT-KEY"] = { password: "SECRET-ROOT" };
      cfg.settings["SECRET-SETTING-KEY"] = { token: "SECRET-SETTING" };
      cfg.servers[0]["SECRET-SERVER-KEY"] = { env: ["SECRET-SERVER"] };
      cfg.servers[0].services[0]["SECRET-SERVICE-KEY"] = "SECRET-SERVICE";
      cfg.settings.links[0]["SECRET-ACTION-KEY"] = "SECRET-ACTION";
    },
    { ...fixture(), settings: { ...fixture().settings, links: [action()] } },
  );
  assert.deepEqual(
    entries.map((entry) => entry.message),
    [
      "Changed: other server fields.",
      "Server: “NAS”. Changed: other service fields.",
      "Changed: other quick action fields.",
      "Changed: other dashboard settings.",
      "Changed: other configuration fields.",
    ],
  );
  assert.doesNotMatch(JSON.stringify(entries), /SECRET/);
});

test("unexpected structural differences get a safe fallback", () => {
  assert.deepEqual(
    describeConfigChanges(
      { servers: [], settings: {} },
      { servers: null, settings: {} },
    ),
    [
      {
        title: "Configuration updated",
        message: "Changed: configuration structure.",
      },
    ],
  );
});

test("privacy sentinels stay private in known fields, unknown keys, and nested metadata", () => {
  const sentinel = "SECRET-SENTINEL";
  const before = fixture();
  before.settings.links = [action()];
  const entries = edit((cfg) => {
    Object.assign(cfg.servers[0], {
      mainUrl: `https://${sentinel}.test`,
      icon: `https://icons.test/${sentinel}`,
      description: sentinel,
      location: sentinel,
      specs: sentinel,
      password: sentinel,
      environment: { [sentinel]: sentinel },
      token: sentinel,
    });
    Object.assign(cfg.servers[0].services[0], {
      urls: [{ label: sentinel, url: `https://${sentinel}.test` }],
      url: `https://${sentinel}.test`,
      altUrl: `https://other.test/${sentinel}`,
      icon: `https://images.test/${sentinel}`,
      notes: sentinel,
      description: sentinel,
      container: sentinel,
      type: sentinel,
      password: sentinel,
    });
    Object.assign(cfg.settings.links[0], {
      url: `https://links.test/${sentinel}`,
      text: sentinel,
      icon: `https://icons.test/${sentinel}`,
      type: sentinel,
      clipboard: sentinel,
      token: sentinel,
    });
    Object.assign(cfg.settings, {
      title: sentinel,
      appName: sentinel,
      accent: sentinel,
      hiddenContainers: [sentinel],
    });
    cfg[sentinel] = { token: sentinel };
  }, before);
  assertShape(entries);
  assert.equal(entries.length, 6);
  assert.doesNotMatch(JSON.stringify(entries), /SECRET-SENTINEL|https?:\/\//);
  assert.match(JSON.stringify(entries), /specifications|URLs|copy text/);
});

test("private payloads remain private during additions, deletions, and moves", () => {
  const secret = "SECRET-PAYLOAD";
  const before = fixture();
  before.servers[0].services[0].notes = secret;
  before.settings.links = [
    action("old", "Old", { text: secret, url: `https://${secret}.test` }),
  ];
  const entries = edit((cfg) => {
    cfg.servers = [
      server(
        "new",
        "New",
        [
          cfg.servers[0].services[0],
          service("other", "Other", { notes: secret }),
        ],
        { location: secret },
      ),
    ];
    cfg.settings.links = [
      action("new", "New", { type: "copy", text: secret, url: "" }),
    ];
  }, before);
  assertShape(entries);
  assert.equal(entries.length, 5);
  assert.doesNotMatch(JSON.stringify(entries), /SECRET-PAYLOAD/);
});

test("names normalize Unicode, strip controls, and stay bounded in titles and messages", () => {
  const before = fixture();
  before.servers[0].name = "ＮＡＳ\u0000\u202e\n";
  before.servers[0].services[0].name = "Ｐｌｅｘ\u001b\u2066";
  assert.deepEqual(
    edit((cfg) => {
      cfg.servers[0].services[0].notes = "private";
    }, before),
    [
      {
        title: "Service updated: “Plex”",
        message: "Server: “NAS”. Changed: notes.",
      },
    ],
  );
  const huge = "A".repeat(300) + "END-OF-NAME";
  before.servers[0].name = huge;
  before.servers[0].services[0].name = huge;
  const entries = edit((cfg) => {
    cfg.servers[0].name = "B".repeat(300);
    cfg.servers[0].services[0].name = "C".repeat(300);
  }, before);
  assertShape(entries);
  assert.match(entries[0].title, /…/);
  assert.doesNotMatch(JSON.stringify(entries), /A{73}|B{73}|C{73}|END-OF-NAME/);
});

test("long move/rename messages and import titles obey hard character caps", () => {
  const before = fixture();
  before.servers[0].name = "A".repeat(300);
  before.servers[0].services[0].name = "B".repeat(300);
  before.servers.push(server("other", "C".repeat(300)));
  const entries = edit((cfg) => {
    const svc = cfg.servers[0].services.pop();
    Object.assign(svc, {
      name: "D".repeat(300),
      url: "SECRET",
      notes: "SECRET",
      icon: "SECRET",
      description: "SECRET",
      container: "SECRET",
      type: "SECRET",
      group: "SECRET",
    });
    cfg.servers[1].services.push(svc);
  }, before);
  assertShape(entries);
  assert.equal(entries.length, 1);
  assert.equal(entries[0].message.length, 400);
  assert.doesNotMatch(JSON.stringify(entries), /SECRET/);
});

test("name and message truncation never split astral Unicode characters", () => {
  const before = fixture();
  before.servers[0].name = "😀".repeat(100);
  before.servers[0].services[0].name = "😀".repeat(100);
  before.servers.push(server("other", "🚀".repeat(100)));
  const entries = edit((cfg) => {
    const svc = cfg.servers[0].services.pop();
    Object.assign(svc, {
      name: "🎬".repeat(100),
      notes: "private",
      description: "private",
      icon: "private",
      type: "web",
      url: "private",
      group: "private",
    });
    cfg.servers[1].services.push(svc);
  }, before);
  assertShape(entries);
  assert.equal(entries.length, 1);
  assert.match(entries[0].title, /🎬/u);
  assert.match(entries[0].message, /😀/u);
});

test("exactly 20 changes have no overflow; further changes report the exact omitted count", () => {
  const before = fixture();
  before.servers[0].services = [];
  const after = copy(before);
  after.servers[0].services = Array.from({ length: 20 }, (_, i) =>
    service(`new-${i}`, `Service ${i}`),
  );
  const twenty = describeConfigChanges(before, after);
  assertShape(twenty);
  assert.equal(twenty.length, 20);
  assert.ok(twenty.every((entry) => entry.title.startsWith("Service added:")));
  after.servers[0].services.push(service("extra", "Extra"));
  assert.deepEqual(describeConfigChanges(before, after).at(-1), {
    title: "Additional configuration changes",
    message: "1 additional change omitted.",
  });
  after.servers[0].services = Array.from({ length: 137 }, (_, i) =>
    service(`new-${i}`, `Service ${i}`),
  );
  const many = describeConfigChanges(before, after);
  assertShape(many);
  assert.equal(many.length, 21);
  assert.deepEqual(many.slice(0, 20), twenty);
  assert.deepEqual(many[20], {
    title: "Additional configuration changes",
    message: "117 additional changes omitted.",
  });
});

test("mixed imports retain specific changes and bound unrelated operation floods", () => {
  const before = fixture();
  before.servers[0].groups = ["Old"];
  before.servers[0].services[0].group = "Old";
  before.settings.links = [action("old", "Old action")];
  before.settings.favorites = ["plex"];
  before.settings.hiddenContainers = ["private-old"];
  const entries = edit((cfg) => {
    cfg.servers[0].name = "Storage";
    cfg.servers[0].groups = ["New"];
    cfg.servers[0].services[0].group = "New";
    cfg.servers[0].services[0].notes = "private note";
    cfg.settings.links = [action("new", "New action")];
    cfg.settings.favorites = [];
    cfg.settings.hiddenContainers = ["private-new"];
    cfg.settings.title = "private title";
    for (let i = 0; i < 30; i++)
      cfg.servers.push(server(`import-${i}`, `Imported ${i}`));
  }, before);
  assertShape(entries);
  // 1 server rename + 1 group rename + 30 added servers + 1 service edit +
  // 1 favorite removal + 2 action changes + 2 visibility changes + 1 setting.
  assert.equal(entries.length, 21);
  assert.equal(entries[20].message, "19 additional changes omitted.");
  assert.deepEqual(titles(entries).slice(0, 2), [
    "Server renamed: “NAS” → “Storage”",
    "Group renamed: “Old” → “New”",
  ]);
  assert.doesNotMatch(JSON.stringify(entries), /private/);
});

test("formatter is deterministic and never mutates frozen input documents", () => {
  const before = fixture();
  before.servers[0].groups = ["Media"];
  before.servers[0].services[0].group = "Media";
  before.settings.favorites = ["plex"];
  before.settings.links = [action()];
  const after = copy(before);
  after.servers[0].groups = ["Entertainment"];
  after.servers[0].services[0].group = "Entertainment";
  after.servers.push(server("mini", "Mini"));
  after.servers[1].services.push(service("new", "New"));
  after.settings.favorites.push("new");
  after.settings.links[0].text = "private";
  after.settings.hiddenContainers.push("private-container");
  const originalBefore = JSON.stringify(before);
  const originalAfter = JSON.stringify(after);
  freeze(before);
  freeze(after);
  const first = describeConfigChanges(before, after);
  const second = describeConfigChanges(before, after);
  assertShape(first);
  assert.deepEqual(first, second);
  assert.notEqual(first, second);
  assert.equal(JSON.stringify(before), originalBefore);
  assert.equal(JSON.stringify(after), originalAfter);
  first[0].title = "changed result";
  assert.notEqual(
    describeConfigChanges(before, after)[0].title,
    "changed result",
  );
});
