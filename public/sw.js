// RAHA POS - Service Worker v1.0
// Offline mode: caches app shell, queues orders when internet is down

const CACHE_NAME = 'raha-pos-v1';
const OFFLINE_QUEUE_KEY = 'raha-offline-queue';

// Files to cache for offline use
const CACHE_FILES = [
    '/',
    '/index.html',
    '/kds.html',
    '/table-order.html',
    'https://cdn.jsdelivr.net/npm/vue@3.3.4/dist/vue.global.prod.js',
    'https://cdn.tailwindcss.com',
    'https://cdn.socket.io/4.6.1/socket.io.min.js',
    'https://cdnjs.cloudflare.com/ajax/libs/font-awesome/6.4.0/css/all.min.css',
];

// ===== INSTALL: cache app shell =====
self.addEventListener('install', event => {
    console.log('[SW] Installing...');
    event.waitUntil(
        caches.open(CACHE_NAME).then(cache => {
            // Cache what we can, ignore failures (CDN files might block)
            return Promise.allSettled(
                CACHE_FILES.map(url => cache.add(url).catch(() => {}))
            );
        }).then(() => self.skipWaiting())
    );
});

// ===== ACTIVATE: clean old caches =====
self.addEventListener('activate', event => {
    event.waitUntil(
        caches.keys().then(keys =>
            Promise.all(keys.filter(k => k !== CACHE_NAME).map(k => caches.delete(k)))
        ).then(() => self.clients.claim())
    );
});

// ===== FETCH: serve from cache when offline =====
self.addEventListener('fetch', event => {
    const url = new URL(event.request.url);

    // Handle POST /api/orders — queue when offline
    if (event.request.method === 'POST' && url.pathname === '/api/orders') {
        event.respondWith(handleOrderPost(event.request));
        return;
    }

    // For API calls: try network first, fall back to cached response
    if (url.pathname.startsWith('/api/')) {
        event.respondWith(
            fetch(event.request).catch(() => {
                // Return empty but valid responses for key endpoints
                if (url.pathname === '/api/menu') {
                    return getCachedMenu();
                }
                if (url.pathname === '/api/dashboard/stats') {
                    return new Response(JSON.stringify({
                        today_orders: 0, today_revenue: 0, pending_orders: 0,
                        cooking_orders: 0, ready_orders: 0, total_customers: 0,
                        _offline: true
                    }), { headers: { 'Content-Type': 'application/json' } });
                }
                if (url.pathname === '/api/orders') {
                    return new Response(JSON.stringify([]), {
                        headers: { 'Content-Type': 'application/json' }
                    });
                }
                return new Response(JSON.stringify({ error: 'Offline' }), {
                    status: 503, headers: { 'Content-Type': 'application/json' }
                });
            })
        );
        return;
    }

    // For page/asset requests: cache first, then network
    event.respondWith(
        caches.match(event.request).then(cached => {
            if (cached) return cached;
            return fetch(event.request).then(response => {
                // Cache successful GET responses
                if (response.ok && event.request.method === 'GET') {
                    const clone = response.clone();
                    caches.open(CACHE_NAME).then(cache => cache.put(event.request, clone));
                }
                return response;
            }).catch(() => {
                // Return cached index.html for navigation requests
                if (event.request.mode === 'navigate') {
                    return caches.match('/index.html');
                }
            });
        })
    );
});

// ===== Handle order POST with offline queue =====
async function handleOrderPost(request) {
    const body = await request.clone().json();

    try {
        // Try to send to server
        const response = await fetch(request);
        if (response.ok) {
            // Success — also try to sync any queued orders
            syncQueue();
            return response;
        }
        throw new Error('Server error');
    } catch (err) {
        // Offline — queue the order locally
        await queueOrder(body);
        // Return a fake success so the UI doesn't show an error
        const fakeOrderNumber = `OFFLINE-${Date.now()}`;
        return new Response(JSON.stringify({
            success: true,
            offline: true,
            order: {
                ...body,
                id: Date.now(),
                order_number: fakeOrderNumber,
                status: 'pending',
                timestamp: new Date().toISOString(),
                _queued: true
            }
        }), { headers: { 'Content-Type': 'application/json' } });
    }
}

// ===== Queue management =====
async function queueOrder(orderData) {
    const cache = await caches.open(CACHE_NAME);
    const existing = await cache.match(OFFLINE_QUEUE_KEY);
    const queue = existing ? await existing.json() : [];
    queue.push({ ...orderData, _queued_at: Date.now() });
    await cache.put(OFFLINE_QUEUE_KEY, new Response(JSON.stringify(queue), {
        headers: { 'Content-Type': 'application/json' }
    }));
    console.log(`[SW] Order queued offline. Queue size: ${queue.length}`);
    // Notify clients
    const clients = await self.clients.matchAll();
    clients.forEach(client => client.postMessage({
        type: 'ORDER_QUEUED',
        queueSize: queue.length
    }));
}

async function syncQueue() {
    try {
        const cache = await caches.open(CACHE_NAME);
        const existing = await cache.match(OFFLINE_QUEUE_KEY);
        if (!existing) return;
        const queue = await existing.json();
        if (!queue.length) return;

        console.log(`[SW] Syncing ${queue.length} queued orders...`);
        const remaining = [];

        for (const order of queue) {
            try {
                const { _queued_at, ...orderData } = order;
                const r = await fetch('/api/orders', {
                    method: 'POST',
                    headers: { 'Content-Type': 'application/json' },
                    body: JSON.stringify(orderData)
                });
                if (!r.ok) remaining.push(order);
                else console.log('[SW] Queued order synced successfully');
            } catch (e) {
                remaining.push(order);
            }
        }

        // Update queue with any that failed
        await cache.put(OFFLINE_QUEUE_KEY, new Response(JSON.stringify(remaining), {
            headers: { 'Content-Type': 'application/json' }
        }));

        // Notify clients of sync result
        const clients = await self.clients.matchAll();
        const synced = queue.length - remaining.length;
        if (synced > 0) {
            clients.forEach(client => client.postMessage({
                type: 'ORDERS_SYNCED',
                synced,
                remaining: remaining.length
            }));
        }
    } catch (e) {
        console.log('[SW] Sync failed:', e);
    }
}

// Cache menu for offline use
async function getCachedMenu() {
    const cache = await caches.open(CACHE_NAME);
    const cached = await cache.match('/api/menu');
    if (cached) return cached.clone();
    return new Response(JSON.stringify([]), {
        headers: { 'Content-Type': 'application/json' }
    });
}

// Sync when back online
self.addEventListener('sync', event => {
    if (event.tag === 'sync-orders') {
        event.waitUntil(syncQueue());
    }
});

// Listen for messages from the app
self.addEventListener('message', event => {
    if (event.data.type === 'SYNC_NOW') {
        syncQueue();
    }
    if (event.data.type === 'CACHE_MENU') {
        caches.open(CACHE_NAME).then(cache => {
            cache.put('/api/menu', new Response(JSON.stringify(event.data.menu), {
                headers: { 'Content-Type': 'application/json' }
            }));
        });
    }
});
