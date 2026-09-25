import { config } from './config.js';

export function zzshuRequestHeaders(headers = {}) {
  return config.zzshuRelayToken
    ? { ...headers, 'X-GPTC-Relay-Token': config.zzshuRelayToken }
    : headers;
}
