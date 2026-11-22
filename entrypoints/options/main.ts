/**
 * entrypoints/options/main.ts — settings page entrypoint: wire the
 * controller to extension storage.
 */
import {
  clearLongPollPendingAcks,
  getLongPollStatus,
  loadLongPollConfig,
  saveLongPollConfig,
  watchLongPollStatus,
} from '../../utils/long-poll-config';
import { SettingsController, type SettingsTransport } from './controller';

const transport: SettingsTransport = {
  loadConfig: loadLongPollConfig,
  saveConfig: saveLongPollConfig,
  getStatus: getLongPollStatus,
  watchStatus: watchLongPollStatus,
  clearPendingAcks: clearLongPollPendingAcks,
};

document.addEventListener('DOMContentLoaded', () => {
  const root = document.getElementById('app');
  if (!root) return;
  new SettingsController(root, transport);
});
