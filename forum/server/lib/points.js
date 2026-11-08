/**
 * 论坛积分「方块」——每日签到
 *
 * 规则：
 *   - 连续签到第 1～7 天分别得 10 / 12 / 14 / 16 / 18 / 20 / 20 方块；
 *   - 第 8 天起每天固定 20 方块；
 *   - 断签（中间空了一天）从第 1 天重新算；
 *   - 每周天（周日）签到额外记一份神秘礼包，礼包内容以后再补；
 *   - 日期一律按论坛时区 Asia/Shanghai 的 0 点切换，不受服务器时区影响。
 */
import { db, now, transaction } from '../db.js';
import { badRequest, notFound } from './http.js';

export const POINTS_NAME = '方块';
export const POINTS_TIMEZONE = 'Asia/Shanghai';
/** 补签卡价格（方块） */
export const MAKEUP_CARD_PRICE = 20;

/** 第 1～7 天签到奖励，下标 0 对应第 1 天；第 8 天起取最后一项 */
export const CHECKIN_REWARDS = [10, 12, 14, 16, 18, 20, 20];

const dayFormatter = new Intl.DateTimeFormat('en-US', {
  timeZone: POINTS_TIMEZONE,
  year: 'numeric',
  month: '2-digit',
  day: '2-digit',
});

const weekdayFormatter = new Intl.DateTimeFormat('en-US', {
  timeZone: POINTS_TIMEZONE,
  weekday: 'short',
});

const pad2 = (value) => String(value).padStart(2, '0');

/** 论坛时区里的日期 YYYY-MM-DD */
export function localDay(date = new Date()) {
  const parts = dayFormatter.formatToParts(date);
  const value = {};
  for (const part of parts) value[part.type] = part.value;
  return `${value.year}-${value.month}-${value.day}`;
}

/** 论坛时区里今天是不是周日 */
export function isSunday(date = new Date()) {
  return weekdayFormatter.format(date) === 'Sun';
}

/** 指定日期（YYYY-MM-DD）是不是周日；补签历史日期时用，不受当前时区影响 */
export function isSundayDay(day) {
  const [year, month, date] = String(day).split('-').map(Number);
  return new Date(Date.UTC(year, month - 1, date)).getUTCDay() === 0;
}

/** 在 YYYY-MM-DD 上加减天数（按日历日算，不涉及时区） */
export function shiftDay(day, amount) {
  const [year, month, date] = String(day).split('-').map(Number);
  const shifted = new Date(Date.UTC(year, month - 1, date + amount));
  return `${shifted.getUTCFullYear()}-${pad2(shifted.getUTCMonth() + 1)}-${pad2(shifted.getUTCDate())}`;
}

/** 连续第 dayNumber 天的签到奖励（第 8 天起固定 20） */
export function rewardFor(dayNumber) {
  const index = Math.min(Math.max(1, Math.floor(Number(dayNumber) || 1)), CHECKIN_REWARDS.length) - 1;
  return CHECKIN_REWARDS[index];
}

/** 记一份当周神秘礼包（同一个周日只记一次），返回这次是不是新记上的 */
function addSundayGift(userId, day) {
  const result = db
    .prepare(
      `INSERT OR IGNORE INTO point_gifts (user_id, week, status, created_at)
       VALUES (?, ?, 'pending', ?)`,
    )
    .run(userId, day, now());
  return Number(result.changes) > 0;
}

/** 对外展示的 7 天签到进度 */
function weekProgress(streak, checkedToday) {
  const currentDay = checkedToday ? streak : streak + 1;
  return CHECKIN_REWARDS.map((reward, index) => {
    const day = index + 1;
    return {
      day,
      reward,
      checked: day <= streak,
      current: day === currentDay && day <= CHECKIN_REWARDS.length,
    };
  });
}

/** 当前账号的积分 / 签到状态（网页和启动器都用这一份） */
export function getPointsState(userId, { historyLimit = 30 } = {}) {
  const account = db.prepare('SELECT points, makeup_cards FROM users WHERE id = ?').get(userId);
  if (!account) throw notFound('用户不存在');

  const today = localDay();
  const yesterday = shiftDay(today, -1);
  const last = db
    .prepare(
      `SELECT day, streak_day, points, sunday_gift, created_at
         FROM point_checkins
        WHERE user_id = ?
        ORDER BY day DESC
        LIMIT 1`,
    )
    .get(userId);
  const checkedToday = !!last && last.day === today;
  const streakAlive = !!last && (last.day === today || last.day === shiftDay(today, -1));
  const streak = streakAlive ? Number(last.streak_day) || 0 : 0;
  const nextDay = streak + 1;
  const history = db
    .prepare(
      `SELECT day, streak_day, points, sunday_gift, created_at
         FROM point_checkins
        WHERE user_id = ?
        ORDER BY day DESC
        LIMIT ?`,
    )
    .all(userId, Math.max(1, Math.min(90, Number(historyLimit) || 30)))
    .map((row) => ({
      day: row.day,
      streak_day: row.streak_day,
      points: row.points,
      sunday_gift: !!row.sunday_gift,
      created_at: row.created_at,
    }));
  const totalCheckins = db
    .prepare('SELECT COUNT(*) AS n FROM point_checkins WHERE user_id = ?')
    .get(userId).n;
  const giftPending = db
    .prepare("SELECT COUNT(*) AS n FROM point_gifts WHERE user_id = ? AND status = 'pending'")
    .get(userId).n;
  const yesterdayRow = db
    .prepare('SELECT id FROM point_checkins WHERE user_id = ? AND day = ?')
    .get(userId, yesterday);
  const makeupCards = Number(account.makeup_cards) || 0;

  return {
    name: POINTS_NAME,
    points: Number(account.points) || 0,
    checked_in_today: checkedToday,
    streak,
    next_day: nextDay,
    reward_today: checkedToday ? Number(last.points) || 0 : rewardFor(nextDay),
    reward_next: rewardFor(nextDay),
    week: weekProgress(streak, checkedToday),
    rewards: CHECKIN_REWARDS.slice(),
    history,
    total_checkins: totalCheckins,
    makeup_cards: makeupCards,
    makeup: {
      price: MAKEUP_CARD_PRICE,
      yesterday,
      yesterday_checked: !!yesterdayRow,
      can_buy: (Number(account.points) || 0) >= MAKEUP_CARD_PRICE,
      can_use: !yesterdayRow && makeupCards > 0,
      reason: yesterdayRow ? 'yesterday_checked' : makeupCards > 0 ? 'ok' : 'no_card',
    },
    sunday: {
      is_sunday: isSunday(),
      gift_pending: giftPending,
    },
    timezone: POINTS_TIMEZONE,
  };
}

/**
 * 签到并发放方块。
 * @returns 更新后的积分状态，外加本次奖励 awarded / streak_day / sunday_gift
 */
export function checkIn(userId) {
  const today = localDay();
  const existing = db
    .prepare('SELECT id FROM point_checkins WHERE user_id = ? AND day = ?')
    .get(userId, today);
  if (existing) throw badRequest('今天已经签到过了，明天再来吧', 'already_checked_in');

  const last = db
    .prepare('SELECT day, streak_day FROM point_checkins WHERE user_id = ? ORDER BY day DESC LIMIT 1')
    .get(userId);
  const streakDay = last && last.day === shiftDay(today, -1) ? Number(last.streak_day) + 1 : 1;
  const amount = rewardFor(streakDay);
  const sunday = isSunday();
  let sundayGift = false;

  transaction(() => {
    db.prepare(
      `INSERT INTO point_checkins (user_id, day, streak_day, points, sunday_gift, created_at)
       VALUES (?, ?, ?, ?, ?, ?)`,
    ).run(userId, today, streakDay, amount, sunday ? 1 : 0, now());

    db.prepare('UPDATE users SET points = points + ? WHERE id = ?').run(amount, userId);

    db.prepare(
      `INSERT INTO point_transactions (user_id, amount, kind, note, created_at)
       VALUES (?, ?, 'checkin', ?, ?)`,
    ).run(userId, amount, `连续签到第 ${streakDay} 天`, now());

    if (sunday)
      sundayGift = addSundayGift(userId, today);
  });

  return {
    ...getPointsState(userId),
    awarded: amount,
    streak_day: streakDay,
    sunday_gift: sundayGift,
  };
}

/** 用方块买一张补签卡 */
export function buyMakeupCard(userId) {
  const account = db.prepare('SELECT points FROM users WHERE id = ?').get(userId);
  if (!account) throw notFound('用户不存在');
  if ((Number(account.points) || 0) < MAKEUP_CARD_PRICE) {
    throw badRequest(`方块不够，补签卡需要 ${MAKEUP_CARD_PRICE} 方块`, 'not_enough_points');
  }

  transaction(() => {
    db.prepare('UPDATE users SET points = points - ?, makeup_cards = makeup_cards + 1 WHERE id = ?').run(
      MAKEUP_CARD_PRICE,
      userId,
    );
    db.prepare(
      `INSERT INTO point_transactions (user_id, amount, kind, note, created_at)
       VALUES (?, ?, 'spend', '购买补签卡', ?)`,
    ).run(userId, -MAKEUP_CARD_PRICE, now());
  });

  return { ...getPointsState(userId), bought: true, price: MAKEUP_CARD_PRICE };
}

/**
 * 用一张补签卡补上昨天。
 *
 * - 昨天没签过才能补；昨天是周日的话，当周神秘礼包也一起记上；
 * - 如果今天已经签到（连续记录已经断了），补签后会把今天的连续天数和奖励一起修好，
 *   少发的方块补到账上，不会让补签只补出个孤立的记录；
 * - 只补昨天，更早的漏签需要以后开放「指定日期补签」再做。
 */
export function useMakeupCard(userId) {
  const today = localDay();
  const yesterday = shiftDay(today, -1);
  const account = db.prepare('SELECT points, makeup_cards FROM users WHERE id = ?').get(userId);
  if (!account) throw notFound('用户不存在');
  if ((Number(account.makeup_cards) || 0) < 1) {
    throw badRequest('还没有补签卡，先买一张吧', 'no_makeup_card');
  }
  const yesterdayRow = db
    .prepare('SELECT id FROM point_checkins WHERE user_id = ? AND day = ?')
    .get(userId, yesterday);
  if (yesterdayRow) throw badRequest('昨天已经签到过了，不需要补签', 'nothing_to_makeup');

  const todayRow = db
    .prepare('SELECT day, streak_day, points FROM point_checkins WHERE user_id = ? AND day = ?')
    .get(userId, today);
  const previous = db
    .prepare(
      `SELECT day, streak_day FROM point_checkins
        WHERE user_id = ? AND day < ?
        ORDER BY day DESC
        LIMIT 1`,
    )
    .get(userId, yesterday);
  const streakDay =
    previous && previous.day === shiftDay(yesterday, -1) ? Number(previous.streak_day) + 1 : 1;
  const amount = rewardFor(streakDay);
  const sundayGift = isSundayDay(yesterday);
  let todayBonus = 0;
  let todayStreak = 0;

  transaction(() => {
    db.prepare(
      `INSERT INTO point_checkins (user_id, day, streak_day, points, sunday_gift, created_at)
       VALUES (?, ?, ?, ?, ?, ?)`,
    ).run(userId, yesterday, streakDay, amount, sundayGift ? 1 : 0, now());

    db.prepare(
      'UPDATE users SET points = points + ?, makeup_cards = makeup_cards - 1 WHERE id = ?',
    ).run(amount, userId);

    db.prepare(
      `INSERT INTO point_transactions (user_id, amount, kind, note, created_at)
       VALUES (?, ?, 'checkin', ?, ?)`,
    ).run(userId, amount, `补签 ${yesterday}（第 ${streakDay} 天）`, now());

    if (sundayGift)
      addSundayGift(userId, yesterday);

    // 今天已经签到过的：昨天补上后，今天的连续天数要跟着接上，奖励差额一起补发
    if (todayRow) {
      todayStreak = streakDay + 1;
      const expected = rewardFor(todayStreak);
      const oldPoints = Number(todayRow.points) || 0;
      const finalPoints = Math.max(expected, oldPoints);
      todayBonus = Math.max(0, expected - oldPoints);
      db.prepare('UPDATE point_checkins SET streak_day = ?, points = ? WHERE user_id = ? AND day = ?').run(
        todayStreak,
        finalPoints,
        userId,
        today,
      );
      if (todayBonus > 0) {
        db.prepare('UPDATE users SET points = points + ? WHERE id = ?').run(todayBonus, userId);
        db.prepare(
          `INSERT INTO point_transactions (user_id, amount, kind, note, created_at)
           VALUES (?, ?, 'checkin', '补签后连续签到奖励补差', ?)`,
        ).run(userId, todayBonus, now());
      }
    }
  });

  return {
    ...getPointsState(userId),
    awarded: amount,
    streak_day: streakDay,
    day: yesterday,
    today_bonus: todayBonus,
    today_repaired: !!todayRow,
    today_streak: todayStreak,
    sunday_gift: sundayGift,
  };
}
