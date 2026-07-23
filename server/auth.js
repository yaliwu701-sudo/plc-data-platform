'use strict';

/**
 * auth.js — 轻量 token 鉴权
 *
 * 设计：
 *  - 登录成功后签发随机 token（内存存储，服务重启需重新登录）
 *  - 默认账号 admin / admin123，可用环境变量覆盖：ADMIN_USER、ADMIN_PASS
 *  - 支持通过 /api/password 修改密码，哈希持久化到 data/config.json（config.adminHash）
 *  - 校验采用常量时间比较，避免计时攻击
 */

const crypto = require('crypto');

const tokens = new Map();      // token -> { user, createdAt }
let customUsers = null;        // { user: hash } 来自 config.adminHash（密码修改后）

function sha(pass) {
  return crypto.createHash('sha256').update((pass == null ? '' : String(pass)) + '|plc-salt').digest('hex');
}

function defaultUser() { return process.env.ADMIN_USER || 'admin'; }
function defaultPass() { return process.env.ADMIN_PASS || 'admin123'; }

function verifyPass(user, pass) {
  let expect;
  if (customUsers && customUsers[user]) {
    expect = customUsers[user];
  } else {
    if (user !== defaultUser()) return false;
    expect = sha(defaultPass());
  }
  const got = sha(pass);
  const a = Buffer.from(expect, 'hex');
  const b = Buffer.from(got, 'hex');
  if (a.length !== b.length) return false;
  return crypto.timingSafeEqual(a, b);
}

function login(user, pass) {
  if (!verifyPass(user, pass)) return null;
  const token = crypto.randomBytes(24).toString('hex');
  tokens.set(token, { user, createdAt: Date.now() });
  return token;
}

function verify(token) {
  if (!token) return null;
  const t = tokens.get(token);
  return t ? t.user : null;
}

function logout(token) {
  if (token) tokens.delete(token);
}

/** 用配置文件中的哈希覆盖默认账号密码（密码修改后调用） */
function setUsers(map) { customUsers = map || null; }

/** 生成密码哈希（供密码修改接口使用） */
function hash(pass) { return sha(pass); }

module.exports = { login, verify, logout, verifyPass, setUsers, hash, defaultUser };
