import { config, requireTrelloCredentials } from "./config.js";
import { fetchWithRetry } from "./http.js";

const baseUrl = "https://api.trello.com/1";

async function trelloRequest(path, options = {}) {
  requireTrelloCredentials();
  const url = new URL(`${baseUrl}${path}`);
  url.searchParams.set("key", config.trello.apiKey);
  url.searchParams.set("token", config.trello.token);

  const method = String(options.method || "GET").toUpperCase();
  const response = await fetchWithRetry(url, {
    ...options,
    headers: { Accept: "application/json", ...(options.headers || {}) }
  }, {
    // Only reads are automatically retried. Retrying a task mutation after a
    // network timeout could create or change it twice.
    retries: method === "GET" ? 2 : 0
  });
  const body = await response.json().catch(() => ({}));
  if (!response.ok) {
    throw new Error(`Trello ${response.status}: ${body.message || "request failed"}`);
  }
  return body;
}

export const trello = {
  me: () => trelloRequest("/members/me"),
  boards: () => trelloRequest("/members/me/boards?fields=name,url,closed"),
  lists: (boardId) => trelloRequest(`/boards/${boardId}/lists?fields=name,closed`),
  createList: (boardId, name, pos = "top") => trelloRequest("/lists", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ idBoard: boardId, name, pos })
  }),
  updateList: (listId, fields) => trelloRequest(`/lists/${listId}`, {
    method: "PUT",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(fields)
  }),
  labels: (boardId) => trelloRequest(`/boards/${boardId}/labels?fields=name,color`),
  updateLabel: (labelId, fields) => trelloRequest(`/labels/${labelId}`, {
    method: "PUT",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(fields)
  }),
  deleteLabel: (labelId) => trelloRequest(`/labels/${labelId}`, { method: "DELETE" }),
  boardCards: (boardId) => trelloRequest(`/boards/${boardId}/cards?fields=name,desc,due,dueComplete,dateLastActivity,idList,url,labels,closed`),
  allBoardCards: (boardId) => trelloRequest(`/boards/${boardId}/cards?filter=all&fields=name,desc,due,dueComplete,dateLastActivity,idList,url,labels,closed`),
  createCard: (fields) => trelloRequest("/cards", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(fields)
  }),
  updateCard: (cardId, fields) => trelloRequest(`/cards/${cardId}`, {
    method: "PUT",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(fields)
  }),
  setCardLabels: (cardId, labelIds) => trelloRequest(`/cards/${cardId}`, {
    method: "PUT",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ idLabels: labelIds.join(",") })
  })
};
