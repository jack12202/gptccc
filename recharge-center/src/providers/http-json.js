async function readResponseBody(response) {
  const text = await response.text();
  if (!text) return {};
  try {
    return JSON.parse(text);
  } catch {
    return { raw: text };
  }
}

export async function requestJson(baseUrl, endpoint, { method = "GET", headers = {}, payload } = {}) {
  const init = {
    method,
    headers
  };

  if (payload !== undefined) {
    init.headers = {
      "Content-Type": "application/json",
      ...headers
    };
    init.body = JSON.stringify(payload);
  }

  const response = await fetch(new URL(endpoint, baseUrl), init);
  const data = await readResponseBody(response);

  return {
    ok: response.ok,
    status: response.status,
    data
  };
}
