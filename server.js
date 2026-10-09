import { createServer } from 'node:http';
import { readFile, writeFile } from 'node:fs/promises';
import { randomUUID, scryptSync, timingSafeEqual } from 'node:crypto';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const directory = path.dirname(fileURLToPath(import.meta.url));
const databasePath = process.env.DB_PATH || path.join(directory, 'db.json');
const port = Number(process.env.PORT || 8080);
const resources = new Set(['assets', 'maintenance', 'operations', 'plans', 'subscriptions', 'purchases', 'incidents', 'notifications']);
const sessionLifetimeMs = Number(process.env.AUTH_SESSION_TTL_HOURS || 12) * 60 * 60 * 1000;

async function database() { return JSON.parse(await readFile(databasePath, 'utf8')); }
async function persist(data) { await writeFile(databasePath, `${JSON.stringify(data, null, 2)}\n`); }
function send(response, status, value) {
  response.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8', 'Access-Control-Allow-Origin': '*', 'Access-Control-Allow-Methods': 'GET,POST,PUT,DELETE,OPTIONS', 'Access-Control-Allow-Headers': 'Content-Type' });
  response.end(JSON.stringify(value));
}
async function body(request) { let raw = ''; for await (const chunk of request) raw += chunk; return raw ? JSON.parse(raw) : {}; }
function publicUser(user) { const { passwordHash, passwordSalt, ...safe } = user; return safe; }
function passwordMatches(password, user) {
  if (!user.passwordHash || !user.passwordSalt) return false;
  const hashed = scryptSync(password, user.passwordSalt, 64);
  return timingSafeEqual(hashed, Buffer.from(user.passwordHash, 'hex'));
}
function createSession(data, user) {
  const session = { id: `SES-${randomUUID()}`, token: randomUUID(), userId: user.id, expiresAt: new Date(Date.now() + sessionLifetimeMs).toISOString() };
  data.sessions ||= [];
  data.sessions.push(session);
  return session;
}
function authenticatedUser(request, data) {
  const token = request.headers.authorization?.replace(/^Bearer\s+/i, '');
  const session = data.sessions?.find((item) => item.token === token && new Date(item.expiresAt) > new Date());
  return session ? data.users?.find((user) => user.id === session.userId) : null;
}
function authRequired(request, response, data, role) {
  const user = authenticatedUser(request, data);
  if (!user) { send(response, 401, { message: 'Authentication required.' }); return null; }
  if (role && user.role !== role) { send(response, 403, { message: 'Insufficient permissions.' }); return null; }
  return user;
}

createServer(async (request, response) => {
  if (request.method === 'OPTIONS') return send(response, 204, null);
  try {
    const url = new URL(request.url, `http://${request.headers.host}`);
    if (url.pathname === '/api/v1/health') return send(response, 200, { status: 'ok', service: 'technoload-platform', time: new Date().toISOString() });
    const data = await database();
    if (url.pathname === '/api/v1/auth/register' && request.method === 'POST') {
      const input = await body(request);
      const name = String(input.name || '').trim();
      const email = String(input.email || '').trim().toLowerCase();
      const password = String(input.password || '');
      if (!name || !email.includes('@') || password.length < 8) return send(response, 422, { message: 'Name, valid email and an 8-character password are required.' });
      if (data.users.some((user) => user.email === email)) return send(response, 409, { message: 'An account already exists for that email.' });
      const passwordSalt = randomUUID().replaceAll('-', '');
      const user = { id: `USR-${randomUUID()}`, name, email, passwordSalt, passwordHash: scryptSync(password, passwordSalt, 64).toString('hex'), role: 'USER', organization: String(input.organization || 'TechnoLoad').trim(), createdAt: new Date().toISOString() };
      data.users.push(user);
      const session = createSession(data, user);
      await persist(data);
      return send(response, 201, { token: session.token, expiresAt: session.expiresAt, user: publicUser(user) });
    }
    if (url.pathname === '/api/v1/auth/login' && request.method === 'POST') {
      const input = await body(request);
      const user = data.users?.find((item) => item.email === String(input.email || '').trim().toLowerCase());
      if (!user || !passwordMatches(String(input.password || ''), user)) return send(response, 401, { message: 'Invalid email or password.' });
      const session = createSession(data, user);
      await persist(data);
      return send(response, 200, { token: session.token, expiresAt: session.expiresAt, user: publicUser(user) });
    }
    if (url.pathname === '/api/v1/auth/me' && request.method === 'GET') {
      const user = authRequired(request, response, data);
      return user && send(response, 200, { user: publicUser(user) });
    }
    if (url.pathname === '/api/v1/auth/logout' && request.method === 'POST') {
      const user = authRequired(request, response, data);
      if (!user) return;
      const token = request.headers.authorization.replace(/^Bearer\s+/i, '');
      data.sessions = data.sessions.filter((session) => session.token !== token);
      await persist(data);
      return send(response, 204, null);
    }
    const [, api, version, resource, id] = url.pathname.split('/');
    if (api !== 'api' || version !== 'v1' || !resources.has(resource)) return send(response, 404, { message: 'Resource not found.' });
    const collection = data[resource]; const index = id ? collection.findIndex(item => item.id === id) : -1;
    if (request.method === 'GET') return id && index < 0 ? send(response, 404, { message: 'Record not found.' }) : send(response, 200, id ? collection[index] : collection);
    if (id && index < 0) return send(response, 404, { message: 'Record not found.' });
    if (request.method === 'POST') { const item = await body(request); if (!item.id) item.id = `${resource.slice(0, 1).toUpperCase()}-${Date.now()}`; collection.push(item); await persist(data); return send(response, 201, item); }
    if (request.method === 'PUT') { collection[index] = { ...collection[index], ...await body(request), id }; await persist(data); return send(response, 200, collection[index]); }
    if (request.method === 'DELETE') { const [deleted] = collection.splice(index, 1); await persist(data); return send(response, 200, deleted); }
    return send(response, 405, { message: 'Method not allowed.' });
  } catch (error) { return send(response, 400, { message: error instanceof Error ? error.message : 'Bad request.' }); }
}).listen(port, () => console.log(`TechnoLoad Platform API at http://localhost:${port}/api/v1`));
