// 云函数 ping：连通性检查（后续正式开发保留为健康检查）
const cloud = require('wx-server-sdk');
cloud.init({ env: cloud.DYNAMIC_CURRENT_ENV });

exports.main = async () => {
  return { ok: true, time: Date.now() };
};
