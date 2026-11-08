import { enforce } from '../lib/rate-limit.js';
import { requireUser } from '../lib/auth.js';
import { buyMakeupCard, checkIn, getPointsState, useMakeupCard } from '../lib/points.js';

export default function register(router) {
  // 当前账号的方块余额、连续签到进度和最近签到记录
  router.get('/api/points', async (ctx) => {
    const user = requireUser(ctx.user);
    return getPointsState(user.id);
  });

  // 每日签到：一天只能签一次，奖励按连续天数发
  router.post('/api/points/check-in', async (ctx) => {
    const user = requireUser(ctx.user);
    enforce(`points-checkin:${user.id}`, 10, 60 * 60 * 1000, '签到太频繁，稍后再试');
    return checkIn(user.id);
  });

  // 用方块买一张补签卡（目前固定 20 方块）
  router.post('/api/points/makeup-card/buy', async (ctx) => {
    const user = requireUser(ctx.user);
    enforce(`points-buy-makeup:${user.id}`, 10, 60 * 60 * 1000, '购买太频繁，稍后再试');
    return buyMakeupCard(user.id);
  });

  // 用一张补签卡补上昨天；今天已经签到的话也会把今天的连续记录接上
  router.post('/api/points/makeup', async (ctx) => {
    const user = requireUser(ctx.user);
    enforce(`points-makeup:${user.id}`, 10, 60 * 60 * 1000, '补签太频繁，稍后再试');
    return useMakeupCard(user.id);
  });
}
