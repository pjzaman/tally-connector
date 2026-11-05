"use strict";

async function requestBuffer(url, options = {}, timeoutMs = 30_000) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const response = await fetch(url, { ...options, signal: controller.signal });
    const body = Buffer.from(await response.arrayBuffer());
    return { response, body };
  } finally {
    clearTimeout(timer);
  }
}

async function request(url, options = {}, timeoutMs = 30_000) {
  const { response, body } = await requestBuffer(url, options, timeoutMs);
  return { response, body: body.toString("utf8") };
}

module.exports = { request, requestBuffer };
