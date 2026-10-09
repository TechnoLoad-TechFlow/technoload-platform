import { createServer } from 'node:http';
import { readFile, writeFile } from 'node:fs/promises';
import { randomUUID, scryptSync, timingSafeEqual } from 'node:crypto';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const directory = path.dirname(fileURLToPath(import.meta.url));
const databasePath = process.env.DB_PATH || path.join(directory, 'db.json');
const port = Number(process.env.PORT || 8080);
const resources = new Set(['assets', 'maintenance', 'operations', 'plans', 'subscriptions']);
const sessionLifetimeMs = Number(process.env.AUTH_SESSION_TTL_HOURS || 12) * 60 * 60 * 1000;

const defaultDatabase = () => ({
  assets: [{ id: 'A-001', name: 'CAT 320 Excavator', type: 'Machinery', usage: 1842, status: 'AVAILABLE' }, { id: 'A-002', name: 'Volvo FMX Dump Truck', type: 'Dump truck', usage: 64500, status: 'IN_OPERATION' }, { id: 'A-003', name: 'XCMG QY25K Crane', type: 'Crane', usage: 3250, status: 'IN_MAINTENANCE' }],
  maintenance: [], operations: [], plans: [{ id: 'starter', name: 'Starter', monthlyPrice: 149, currency: 'PEN' }, { id: 'professional', name: 'Professional', monthlyPrice: 349, currency: 'PEN' }], subscriptions: [], users: [{ id: 'USR-ADMIN-001', name: 'TechFlow Administrator', email: 'admin@technoload.pe', role: 'ADMIN', organization: 'TechnoLoad Demo', passwordSalt: 'aa93e4ecdcd7a39adb36ae1cea9adfa9', passwordHash: '0957295b0bbe656f6f8464f7ae7d71093905d282b26e7b834b3d2a7112d595dbf250f8030529a9caad412b9ebc35b6e4a8df2b2e72fccedf57be198b2fb21e21' }, { id: 'USR-USER-001', name: 'Demo Customer', email: 'user@technoload.pe', role: 'USER', organization: 'Demo Construction', passwordSalt: '14ba84e9ab06425085797a85a4dbb51b', passwordHash: 'f1482f89ab33bb3be9a541b3ea9cc51e816fda1d06cc8ac4f2b40e81e3d821a49c77c4460f4103648c72b96f470ecba06a3b3eee264ac47871ccf68bf76201cb' }], sessions: [], purchases: [], rentals: [], payments: [], incidents: [], notifications: []
});
async function database() { try { return JSON.parse(await readFile(databasePath, 'utf8')); } catch (error) { if (error.code === 'ENOENT') return defaultDatabase(); throw error; } }
async function persist(data) { await writeFile(databasePath, `${JSON.stringify(data, null, 2)}\n`); }
function send(response, status, value) {
  response.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8', 'Access-Control-Allow-Origin': '*', 'Access-Control-Allow-Methods': 'GET,POST,PUT,DELETE,OPTIONS', 'Access-Control-Allow-Headers': 'Content-Type, Authorization' });
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
function notify(data, userId, title, message, type = 'INFO') {
  data.notifications ||= [];
  data.notifications.unshift({ id: `NOT-${randomUUID()}`, userId, title, message, type, read: false, createdAt: new Date().toISOString() });
}
function rentalDays(startDate, endDate) { return Math.ceil((new Date(endDate) - new Date(startDate)) / 86400000) + 1; }
function rentalEligible(asset, startDate, endDate) {
  const days = rentalDays(startDate, endDate);
  return Boolean(asset && asset.status === 'AVAILABLE' && Number.isInteger(days) && days > 0 && days <= 30 && new Date(startDate) >= new Date(new Date().toISOString().slice(0, 10)));
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
    if (url.pathname === '/api/v1/admin/users' && request.method === 'GET') {
      const user = authRequired(request, response, data, 'ADMIN');
      return user && send(response, 200, data.users.map(publicUser));
    }
    if (url.pathname === '/api/v1/admin/overview' && request.method === 'GET') {
      const user = authRequired(request, response, data, 'ADMIN');
      if (!user) return;
      return send(response, 200, {
        users: data.users.length,
        pendingPurchases: data.purchases.filter((purchase) => purchase.status === 'PENDING_APPROVAL').length,
        openIncidents: data.incidents.filter((incident) => incident.status !== 'RESOLVED').length,
        activeSubscriptions: data.subscriptions.filter((subscription) => subscription.status === 'ACTIVE').length
      });
    }
    if (url.pathname === '/api/v1/catalog/assets' && request.method === 'GET') {
      return send(response, 200, data.assets.filter((asset) => asset.status === 'AVAILABLE'));
    }
    if (url.pathname === '/api/v1/customer/overview' && request.method === 'GET') {
      const user = authRequired(request, response, data);
      if (!user) return;
      return send(response, 200, {
        rentals: data.rentals.filter((rental) => rental.userId === user.id),
        subscriptions: data.subscriptions.filter((subscription) => subscription.userId === user.id),
        notifications: data.notifications.filter((notification) => notification.userId === user.id).slice(0, 20)
      });
    }
    if (url.pathname === '/api/v1/rentals' && request.method === 'POST') {
      const user = authRequired(request, response, data);
      if (!user || user.role === 'ADMIN') return;
      const input = await body(request);
      const asset = data.assets.find((item) => item.id === input.assetId);
      const eligible = rentalEligible(asset, input.startDate, input.endDate);
      if (!asset || !input.startDate || !input.endDate) return send(response, 422, { message: 'Choose an available asset, start date and end date.' });
      const rental = { id: `RNT-${randomUUID()}`, userId: user.id, assetId: asset.id, startDate: input.startDate, endDate: input.endDate, days: rentalDays(input.startDate, input.endDate), status: eligible ? 'AUTO_APPROVED' : 'PENDING_REVIEW', createdAt: new Date().toISOString() };
      data.rentals.unshift(rental);
      if (eligible) asset.status = 'RESERVED';
      notify(data, user.id, eligible ? 'Reservation approved' : 'Reservation under review', eligible ? `${asset.name} was automatically reserved for your selected dates.` : 'Your request needs an administrator review.');
      data.users.filter((item) => item.role === 'ADMIN').forEach((admin) => notify(data, admin.id, 'New rental request', `${user.name} requested ${asset.name}.`, 'RENTAL'));
      await persist(data);
      return send(response, 201, rental);
    }
    if (url.pathname === '/api/v1/subscriptions/checkout' && request.method === 'POST') {
      const user = authRequired(request, response, data);
      if (!user || user.role === 'ADMIN') return;
      const input = await body(request);
      const plan = data.plans.find((item) => item.id === input.planId);
      if (!plan || plan.monthlyPrice === null) return send(response, 422, { message: 'Choose an available monthly plan.' });
      const payment = { id: `PAY-${randomUUID()}`, userId: user.id, planId: plan.id, amount: plan.monthlyPrice, currency: plan.currency, provider: 'SANDBOX', method: input.method === 'CARD' ? 'CARD' : 'YAPE', status: 'PAID', createdAt: new Date().toISOString() };
      data.payments.unshift(payment);
      const subscription = { id: `SUB-${randomUUID()}`, userId: user.id, organization: user.organization, planId: plan.id, status: 'ACTIVE', startedAt: new Date().toISOString(), paymentId: payment.id };
      data.subscriptions.unshift(subscription);
      notify(data, user.id, 'Membership activated', `${plan.name} is active. Your benefits and priority level are now applied.`, 'SUBSCRIPTION');
      await persist(data);
      return send(response, 201, { subscription, payment });
    }
    if (url.pathname === '/api/v1/incidents' && request.method === 'POST') {
      const user = authRequired(request, response, data);
      if (!user || user.role === 'ADMIN') return;
      const input = await body(request);
      const asset = data.assets.find((item) => item.id === input.assetId);
      if (!asset || !String(input.description || '').trim()) return send(response, 422, { message: 'Choose an asset and describe the issue.' });
      const incident = { id: `INC-${randomUUID()}`, userId: user.id, assetId: asset.id, description: String(input.description).trim(), status: 'OPEN', createdAt: new Date().toISOString() };
      data.incidents.unshift(incident); asset.status = 'IN_MAINTENANCE';
      notify(data, user.id, 'Issue reported', `We notified the operations team about ${asset.name}.`, 'INCIDENT');
      data.users.filter((item) => item.role === 'ADMIN').forEach((admin) => notify(data, admin.id, 'New equipment issue', `${user.name} reported an issue with ${asset.name}.`, 'INCIDENT'));
      await persist(data);
      return send(response, 201, incident);
    }
    if (url.pathname === '/api/v1/notifications/read' && request.method === 'POST') {
      const user = authRequired(request, response, data);
      if (!user) return;
      data.notifications.filter((notification) => notification.userId === user.id).forEach((notification) => { notification.read = true; });
      await persist(data); return send(response, 200, { ok: true });
    }
    if (url.pathname === '/api/v1/admin/requests' && request.method === 'GET') {
      const user = authRequired(request, response, data, 'ADMIN');
      if (!user) return;
      return send(response, 200, { rentals: data.rentals, incidents: data.incidents, payments: data.payments, subscriptions: data.subscriptions });
    }
    if (url.pathname.startsWith('/api/v1/admin/rentals/') && url.pathname.endsWith('/decision') && request.method === 'POST') {
      const user = authRequired(request, response, data, 'ADMIN');
      if (!user) return;
      const rentalId = url.pathname.split('/')[5]; const rental = data.rentals.find((item) => item.id === rentalId); const input = await body(request);
      if (!rental) return send(response, 404, { message: 'Rental request not found.' });
      rental.status = input.approved ? 'APPROVED' : 'REJECTED';
      const asset = data.assets.find((item) => item.id === rental.assetId); if (input.approved && asset) asset.status = 'RESERVED';
      notify(data, rental.userId, input.approved ? 'Reservation approved' : 'Reservation declined', `Your rental request was ${input.approved ? 'approved' : 'declined'} by an administrator.`, 'RENTAL');
      await persist(data); return send(response, 200, rental);
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
