function wait(milliseconds) {
  return new Promise((resolve) => setTimeout(resolve, milliseconds));
}

function retryableResponse(response) {
  return response.status === 429 || response.status >= 500;
}

export async function fetchWithRetry(url, options = {}, {
  fetchImpl = fetch,
  timeoutMs = 12_000,
  retries = 0,
  retryDelayMs = 250,
  shouldRetryResponse = retryableResponse
} = {}) {
  let lastError;
  for (let attempt = 0; attempt <= retries; attempt += 1) {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), timeoutMs);
    try {
      const response = await fetchImpl(url, { ...options, signal: controller.signal });
      if (!shouldRetryResponse(response) || attempt === retries) return response;
      lastError = new Error(`Request failed with ${response.status}.`);
    } catch (error) {
      lastError = controller.signal.aborted
        ? new Error(`Request timed out after ${timeoutMs}ms.`)
        : error;
      if (attempt === retries) throw lastError;
    } finally {
      clearTimeout(timeout);
    }
    await wait(retryDelayMs * (attempt + 1));
  }
  throw lastError || new Error("Request failed.");
}
