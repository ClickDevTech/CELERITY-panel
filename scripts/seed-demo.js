// Seed demo data into the LOCAL panel DB so every UI page has content.
const mongoose = require('mongoose');
const crypto = require('crypto');
(async () => {
  await mongoose.connect('mongodb://localhost:27017/hysteria');
  const HyNode = require('../src/models/hyNodeModel');
  const HyUser = require('../src/models/hyUserModel');

  await HyNode.deleteMany({});
  await HyUser.deleteMany({});

  const nodes = [
    { name: 'Eindhoven', flag: '🇳🇱', ip: 'whitelist.twilightparadox.com', domain: 'whitelist.twilightparadox.com', sni: 'whitelist.twilightparadox.com', port: 1335, portRange: '20000-50000', subscriptionVariants: 'both', type: 'hysteria', active: true, status: 'online', onlineUsers: 12, maxOnlineUsers: 40, rankingCoefficient: 1.2, ssh: ' []', description: 'Основная NL-нода, hysteria2 QUIC + ACME', cpu: 34, ram: 58, disk: 41 },
    { name: 'Utrecht', flag: '🇳🇱', ip: '147.45.218.172', port: 8443, type: 'xray', active: true, status: 'online', onlineUsers: 9, maxOnlineUsers: 40, rankingCoefficient: 1, ssh: ' []', description: 'Reality VLESS — запасной вход, сеть напряжённая в вечерние часы' },
    { name: 'Белые списки', flag: '🇷🇺', ip: '147.45.218.172', port: 1335, subscriptionVariants: 'tls', type: 'hysteria', active: true, status: 'online', onlineUsers: 31, maxOnlineUsers: 40, rankingCoefficient: 1, ssh: ' []', description: 'RU-домены напрямую, реклама режется' },
    { name: 'Heidelberg', flag: '🇩🇪', ip: '147.45.198.201', port: 1335, subscriptionVariants: 'both', type: 'hysteria', active: true, status: 'offline', onlineUsers: 0, maxOnlineUsers: 20, rankingCoefficient: 1, ssh: ' []', description: 'Панель+нода на одном хосте, пока без домена' },
    { name: 'Kiruna', flag: '🇸🇪', ip: '138.124.80.18', port: 1335, type: 'hysteria', active: false, status: 'offline', onlineUsers: 0, maxOnlineUsers: 20, rankingCoefficient: 1, ssh: ' []', description: 'Скрыта по просьбе заказчика' },
  ];
  const created = [];
  for (const n of nodes) {
    try { created.push(await HyNode.create(n)); } catch (e) { console.log('NODE FAIL', n.name, e.message); }
  }
  console.log('nodes created:', created.length);

  const names = ['vanek', 'masha', 'grimlock', 'sasha', 'ivan', 'kate', 'admin_test', 'probe_01', 'probe_02', 'user_x'];
  for (let i = 0; i < names.length; i++) {
    const n = names[i];
    const token = crypto.randomBytes(8).toString('hex');
    try {
      await HyUser.create({
        userId: String(i + 1),
        password: crypto.randomBytes(8).toString('hex').slice(0, 12),
        subscriptionToken: token,
        active: i < 8,
        expiresAt: i === 7 ? new Date(Date.now() - 86400000) : null,
        traffic: { tx: Math.floor(5e9 * (i + 1) / 3) % 4e10, rx: Math.floor(2e9 * (i + 1) / 3) % 3e10 },
        trafficLimit: i % 3 === 0 ? 0 : 5e10,
        nodes: [],
        groups: [],
      });
    } catch (e) { console.log('USER FAIL', n, e.message); break; }
  }
  console.log('users created');
  await mongoose.disconnect();
})();
