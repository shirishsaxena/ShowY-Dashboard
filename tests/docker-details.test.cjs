"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const vm = require("node:vm");
const { createRequire } = require("node:module");
const { EventEmitter } = require("node:events");
const { parseStats } = require("../lib/docker");
const ID = "a".repeat(64);

function load(file, mocks = {}) {
  const filename = path.join(__dirname, "..", file);
  const local = createRequire(filename);
  const module = { exports: {} };
  vm.runInNewContext(
    fs.readFileSync(filename, "utf8"),
    {
      module,
      Buffer,
      AbortController,
      require: (name) =>
        Object.hasOwn(mocks, name) ? mocks[name] : local(name),
    },
    { filename },
  );
  return module.exports;
}

function inspect(state = "running") {
  return {
    Id: ID,
    Name: "/app",
    Image: "sha256:image",
    Created: "2026-10-24T01:00:00Z",
    RestartCount: 2,
    Config: {
      Image: "app:latest",
      Hostname: "app-host",
      User: "1000",
      Env: ["TOKEN=private-env"],
      Cmd: ["--secret", "private-command"],
      Labels: {
        token: "private-label",
        "com.docker.compose.project": "media",
        "com.docker.compose.service": "app",
      },
    },
    State: {
      Status: state,
      StartedAt: "2026-10-24T02:00:00Z",
      ExitCode: 0,
      OOMKilled: false,
      Health: {
        Status: "healthy",
        FailingStreak: 0,
        Log: [{ Output: "private-health-output" }],
      },
    },
    HostConfig: {
      Memory: 4096,
      NanoCpus: 1500000000,
      RestartPolicy: { Name: "unless-stopped" },
      Privileged: false,
      ReadonlyRootfs: true,
      LogConfig: { Type: "json-file", Config: { token: "private-log-config" } },
    },
    NetworkSettings: {
      Ports: {
        "80/tcp": [{ HostIp: "127.0.0.1", HostPort: "8080" }],
        "53/udp": null,
      },
      Networks: {
        bridge: {
          IPAddress: "172.17.0.2",
          Gateway: "172.17.0.1",
          MacAddress: "02:00:00:00:00:01",
        },
      },
    },
    Mounts: [
      {
        Type: "bind",
        Source: "/private-host-source",
        Destination: "/data",
        RW: true,
      },
    ],
  };
}
const stats = () => ({
  cpu_stats: { cpu_usage: { total_usage: 200 }, system_cpu_usage: 2000 },
  precpu_stats: { cpu_usage: { total_usage: 100 }, system_cpu_usage: 1000 },
  memory_stats: { usage: 1024, limit: 4096, stats: { inactive_file: 128 } },
  networks: { eth0: { rx_bytes: 123, tx_bytes: 456 } },
  blkio_stats: {
    io_service_bytes_recursive: [
      { op: "Read", value: 300 },
      { op: "Write", value: 200 },
    ],
  },
  pids_stats: { current: 4 },
});

function fixture(
  read = async (route) => (route.endsWith("/json") ? inspect() : stats()),
) {
  const calls = [];
  const api = load("lib/docker-details.js", {
    "./docker": {
      parseStats,
      dockerGet: (...args) => {
        calls.push(args);
        return read(...args);
      },
    },
  });
  return { ...api, calls };
}

test("container details query only the selected ID and calculate fresh usage without a shared cache", async () => {
  const h = fixture();
  const controller = new AbortController();
  const data = await h.getContainerDetails(ID, { signal: controller.signal });
  assert.deepEqual(
    h.calls.map(([route]) => route),
    [`/containers/${ID}/json`, `/containers/${ID}/stats?stream=false`],
  );
  assert.equal(h.calls[0][1], 5000);
  assert.equal(h.calls[1][1], 8000);
  assert.ok(
    h.calls.every(
      (call) =>
        call[2].maxBytes === 1024 * 1024 &&
        call[2].signal === controller.signal,
    ),
  );
  assert.equal(data.usage.cpu, 10);
  assert.equal(data.usage.mem, 896);
  assert.equal(data.usage.memoryPercent, 21.9);
  assert.equal(data.usage.rx, 123);
  assert.equal(data.usage.tx, 456);
  assert.equal(data.usage.blockRead, 300);
  assert.equal(data.usage.blockWrite, 200);
  assert.equal(data.usage.pids, 4);
  await h.getContainerDetails(ID);
  assert.equal(h.calls.length, 4);
});

test("inspection exposes whitelisted metadata and never returns secrets or host mount sources", async () => {
  const data = await fixture().getContainerDetails(ID);
  assert.equal(data.container.health, "healthy");
  assert.equal(data.container.cpuLimit, 1.5);
  assert.equal(data.container.composeProject, "media");
  assert.equal(data.container.ports[0].host, "8080");
  assert.equal(data.container.ports[1].host, "");
  assert.equal(data.container.networks[0].address, "172.17.0.2");
  assert.equal(data.container.mounts[0].destination, "/data");
  assert.doesNotMatch(
    JSON.stringify(data),
    /private-|TOKEN|Cmd|Env|Labels|Source/,
  );
});

test("stopped containers still have details, while missing usage is not reported as zero", async () => {
  const stopped = fixture(async () => inspect("exited"));
  const data = await stopped.getContainerDetails(ID);
  assert.equal(stopped.calls.length, 1);
  assert.equal(data.usage, null);
  assert.match(data.usageError, /running containers/);
  const partial = fixture(async (route) => {
    if (route.endsWith("/json")) return inspect();
    throw new Error("private network failure");
  });
  const snapshot = await partial.getContainerDetails(ID);
  assert.equal(snapshot.container.name, "app");
  assert.equal(snapshot.usage, null);
  assert.doesNotMatch(snapshot.usageError, /private/);
  const unsupported = fixture(async (route) => {
    if (route.endsWith("/json")) return inspect();
    const data = stats();
    delete data.networks;
    delete data.blkio_stats;
    delete data.pids_stats;
    return data;
  });
  const usage = (await unsupported.getContainerDetails(ID)).usage;
  assert.equal(usage.rx, null);
  assert.equal(usage.blockRead, null);
  assert.equal(usage.pids, null);
});

test("invalid IDs and invalid metadata cannot select other Docker endpoints", async () => {
  const h = fixture();
  for (const id of [null, "", "app", "../info", `${ID}?all=1`])
    await assert.rejects(h.getContainerDetails(id), { status: 400 });
  assert.equal(h.calls.length, 0);
  await assert.rejects(fixture(async () => ({})).getContainerDetails(ID), {
    status: 502,
  });
  await assert.rejects(
    fixture(async () => {
      throw Object.assign(new Error("private detail"), { statusCode: 404 });
    }).getContainerDetails(ID),
    (err) => err.status === 404 && /no longer exists/.test(err.message),
  );
});

test("preview concurrency is bounded and cancellation releases request slots", async () => {
  const h = fixture(
    (_route, _timeout, { signal }) =>
      new Promise((_resolve, reject) => {
        signal.addEventListener(
          "abort",
          () =>
            reject(Object.assign(new Error("aborted"), { name: "AbortError" })),
          { once: true },
        );
      }),
  );
  const controllers = Array.from({ length: 4 }, () => new AbortController());
  const checked = controllers.map((controller) =>
    assert.rejects(h.getContainerDetails(ID, { signal: controller.signal }), {
      status: 499,
    }),
  );
  await assert.rejects(h.getContainerDetails(ID), { status: 429 });
  controllers.forEach((controller) => controller.abort());
  await Promise.all(checked);
  const controller = new AbortController();
  const retry = assert.rejects(
    h.getContainerDetails(ID, { signal: controller.signal }),
    { status: 499 },
  );
  controller.abort();
  await retry;
  assert.equal(h.calls.length, 5);
});

test("bounded Docker JSON helper forwards cancellation and destroys oversized replies", async () => {
  let request;
  let response;
  let options;
  const docker = load("lib/docker.js", {
    http: {
      request(settings, callback) {
        options = settings;
        request = new EventEmitter();
        request.end = () => {};
        request.destroy = (err) => {
          request.destroyed = true;
          request.emit("error", err);
        };
        response = new EventEmitter();
        response.statusCode = 200;
        response.setEncoding = () => {};
        queueMicrotask(() => callback(response));
        return request;
      },
    },
  });
  const controller = new AbortController();
  const result = docker.dockerGet("/test", 1000, {
    maxBytes: 10,
    signal: controller.signal,
  });
  const failed = assert.rejects(result, { code: "DOCKER_RESPONSE_TOO_LARGE" });
  await Promise.resolve();
  response.emit("data", "x".repeat(11));
  await failed;
  assert.equal(options.signal, controller.signal);
  assert.equal(request.destroyed, true);
});

test("single-container route passes only the requested ID and cancels disconnected clients", async () => {
  let options;
  let finish;
  const routes = load("routes/system.js", {
    "../lib/docker-details": {
      getContainerDetails: (id, value) => {
        assert.equal(id, ID);
        options = value;
        return new Promise((resolve) => {
          finish = resolve;
        });
      },
    },
  });
  const route = routes["GET /api/docker/details"];
  assert.equal(route.access, "view");
  const res = new EventEmitter();
  const pending = route.handler({}, res, {
    query: new URLSearchParams({ id: ID }),
  });
  assert.equal(options.signal.aborted, false);
  res.emit("close");
  assert.equal(options.signal.aborted, true);
  finish({ container: { id: ID } });
  await pending;
  assert.equal(res.listenerCount("close"), 0);
});
