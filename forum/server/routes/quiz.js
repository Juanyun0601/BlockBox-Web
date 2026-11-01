import { db, now } from '../db.js';
import { badRequest } from '../lib/http.js';
import { enforce } from '../lib/rate-limit.js';
import { requireUser } from '../lib/auth.js';
import { QUIZ_RULES, quizQuestions } from '../lib/quiz.js';

export default function register(router) {
  // 题库（含答案，判分在客户端完成：启动器本地判、网页在浏览器里判）
  router.get('/api/quiz/bank', async (ctx) => {
    requireUser(ctx.user);
    return { rules: QUIZ_RULES, count: quizQuestions.length, questions: quizQuestions };
  });

  // 记录一次答题结果：达到及格线才算通过，历史最高分保留
  router.post('/api/quiz/complete', async (ctx) => {
    const user = requireUser(ctx.user);
    enforce(`quiz:${user.id}`, 12, 60 * 60 * 1000, '答题提交太频繁');

    const body = await ctx.json();
    const score = Math.floor(Number(body.score));
    if (!Number.isFinite(score) || score < 0 || score > 100) {
      throw badRequest('分数不合法', 'bad_score');
    }

    const row = db.prepare('SELECT quiz_passed_at, quiz_best_score FROM users WHERE id = ?').get(user.id);
    const firstTime = !row.quiz_passed_at && score >= QUIZ_RULES.pass_score;
    const passedAt = row.quiz_passed_at || (score >= QUIZ_RULES.pass_score ? now() : 0);
    const best = Math.max(Number(row.quiz_best_score ?? -1), score);
    db.prepare('UPDATE users SET quiz_passed_at = ?, quiz_best_score = ? WHERE id = ?').run(
      passedAt,
      best,
      user.id,
    );

    return { ok: true, quiz_passed: !!passedAt, quiz_best_score: best, first_time: firstTime };
  });
}
