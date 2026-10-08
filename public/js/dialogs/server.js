// Add / edit server dialog.

import { findServer } from '../state.js';
import { $ } from '../dom.js';
import * as actions from '../actions.js';
import { field, value } from './common.js';
import { iconPicker } from './icon-picker.js';

let picker;

export function openServerEditor(serverId = null) {
  const form = $('#serverForm');
  form.reset();
  const server = (serverId && findServer(serverId)) || {};
  form.dataset.serverId = serverId || '';
  $('#serverDialogTitle').textContent = serverId ? 'Edit server' : 'Add server';
  $('#serverDelete').hidden = !serverId;
  for (const key of ['name', 'icon', 'mainUrl', 'description', 'location', 'specs']) field(form, key).value = server[key] || '';
  field(form, 'local').checked = Boolean(server.local);
  picker.reset();
  $('#serverDialog').showModal();
}

export function initServerForm() {
  const form = $('#serverForm');
  picker = iconPicker(form, $('#serverIconPreview'), $('#serverIconSuggest'));

  form.addEventListener('submit', async (e) => {
    e.preventDefault();
    const ok = await actions.saveServer(form.dataset.serverId || null, {
      name: value(form, 'name'),
      icon: value(form, 'icon'),
      mainUrl: value(form, 'mainUrl'),
      description: value(form, 'description'),
      location: value(form, 'location'),
      specs: value(form, 'specs'),
      local: field(form, 'local').checked,
    });
    if (ok) $('#serverDialog').close();
  });

  $('#serverDelete').addEventListener('click', async () => {
    if (await actions.deleteServer(form.dataset.serverId)) $('#serverDialog').close();
  });
}
