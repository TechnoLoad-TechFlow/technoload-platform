import { createServer } from 'node:http';
import { readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const directory = path.dirname(fileURLToPath(import.meta.url));
const databasePath = process.env.DB_PATH || path.join(directory, 'db.json');
const port = Number(process.env.PORT || 8080);
const resources = new Set(['assets', 'maintenance', 'operations', 'plans', 'subscriptions']);

async function database() { return JSON.parse(await readFile(databasePath, 'utf8')); }
async function persist(data) { await writeFile(databasePath, `${JSON.stringify(data, null, 2)}\n`); }
function send(response, status, value) {
  response.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8', 'Access-Control-Allow-Origin': '*', 'Access-Control-Allow-Methods': 'GET,POST,PUT,DELETE,OPTIONS', 'Access-Control-Allow-Headers': 'Content-Type' });
  response.end(JSON.stringify(value));
}
async function body(request) { let raw = ''; for await (const chunk of request) raw += chunk; return raw ? JSON.parse(raw) : {}; }

createServer(async (request, response) => {
  if (request.method === 'OPTIONS') return send(response, 204, null);
  try {
    const url = new URL(request.url, `http://${request.headers.host}`);
    if (url.pathname === '/api/v1/health') return send(response, 200, { status: 'ok', service: 'technoload-platform', time: new Date().toISOString() });
    const [, api, version, resource, id] = url.pathname.split('/');
    if (api !== 'api' || version !== 'v1' || !resources.has(resource)) return send(response, 404, { message: 'Resource not found.' });
    const data = await database(); const collection = data[resource]; const index = id ? collection.findIndex(item => item.id === id) : -1;
    if (request.method === 'GET') return id && index < 0 ? send(response, 404, { message: 'Record not found.' }) : send(response, 200, id ? collection[index] : collection);
    if (id && index < 0) return send(response, 404, { message: 'Record not found.' });
    if (request.method === 'POST') { const item = await body(request); if (!item.id) item.id = `${resource.slice(0, 1).toUpperCase()}-${Date.now()}`; collection.push(item); await persist(data); return send(response, 201, item); }
    if (request.method === 'PUT') { collection[index] = { ...collection[index], ...await body(request), id }; await persist(data); return send(response, 200, collection[index]); }
    if (request.method === 'DELETE') { const [deleted] = collection.splice(index, 1); await persist(data); return send(response, 200, deleted); }
    return send(response, 405, { message: 'Method not allowed.' });
  } catch (error) { return send(response, 400, { message: error instanceof Error ? error.message : 'Bad request.' }); }
}).listen(port, () => console.log(`TechnoLoad Platform API at http://localhost:${port}/api/v1`));
