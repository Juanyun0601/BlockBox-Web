// 入站答题页：抽 50 题、逐题作答（答错立刻显示答案和解析）、通过后把成绩记到账号上
BB.boot(async () => {
  const host = document.getElementById('quizHost');
  const nextParam = BB.param('next');
  // 只接受站内相对路径，避免跳到站外
  const safeNext = nextParam && nextParam.startsWith('/') && !nextParam.startsWith('//') ? nextParam : '';

  // 动态文案（带数字/字母的句子）走模板翻译；普通文本交给页面级 i18n 扫描
  const T = (text) => (window.BBF ? BBF.t(text) : text);
  const TF = (text, ...args) => {
    if (window.BBF) return BBF.tf(text, ...args);
    return text.replace(/\{(\d+)\}/g, (match, i) => (args[Number(i)] == null ? match : args[Number(i)]));
  };

  if (!BB.isLoggedIn()) {
    host.innerHTML = `<div class="card composer">
      <h3>先登录，再答题</h3>
      <p class="muted small" style="margin-bottom: 14px">答题结果和论坛账号绑定：登录后通过答题，发帖和回复就解锁了。</p>
      <div class="composer-foot">
        <a class="btn btn-primary" href="${BB.loginLink('/quiz.html')}">登录 / 注册</a>
      </div>
    </div>`;
    return;
  }

  const me = BB.state.me;
  let bank = null;

  const handleError = (error) => {
    console.error(error);
    host.innerHTML = `<div class="card composer quiz-card">
      <h3>题库加载失败</h3>
      <p class="muted small">${BB.esc(error.message || '稍后再试')}</p>
      <div class="quiz-foot">
        <a class="btn btn-ghost" href="/">返回论坛</a>
        <button class="btn btn-primary" id="retryBtn">重试</button>
      </div>
    </div>`;
    document.getElementById('retryBtn').addEventListener('click', () => startExam().catch(handleError));
  };

  try {
    const lang = window.BBF && typeof BBF.lang === 'function' ? BBF.lang() : '';
    bank = await BB.api('/api/quiz/bank' + (lang ? '?lang=' + encodeURIComponent(lang) : ''));
  } catch (error) {
    handleError(error);
    return;
  }

  const rules = bank.rules || {};
  const perQuestion = Number(rules.points_per_question) || 2;
  const passScore = Number(rules.pass_score) || 80;

  const shuffle = (items) => {
    const list = items.slice();
    for (let i = list.length - 1; i > 0; i -= 1) {
      const j = Math.floor(Math.random() * (i + 1));
      [list[i], list[j]] = [list[j], list[i]];
    }
    return list;
  };

  const renderIntro = () => {
    const passed = !!me.quiz_passed;
    const best = Number(me.quiz_best_score ?? -1);
    host.innerHTML = `<div class="card composer quiz-card">
      <h3>入站答题</h3>
      <p class="muted small">发帖和回复前需要先通过入站答题。成绩记在账号上，换设备、用启动器登录都有效。</p>
      ${passed
        ? `<div class="notice">你已经通过答题${best >= 0 ? `（最高 ${best} 分）` : ''}，发帖和回复都是解锁状态。想再刷一遍也可以。</div>`
        : ''}
      <ul class="quiz-rules">
        <li>${TF('从题库随机抽 {0} 题，每题 {1} 分', Number(rules.question_count) || 50, perQuestion)}</li>
        <li>${T('选错会立刻显示正确答案和解析，边答边学')}</li>
        <li>${TF('拿到 {0} 分及以上即通过，通过后就能发帖和回复', passScore)}</li>
        <li>${T('不限制次数，没通过随时可以再答')}</li>
      </ul>
      <div class="composer-foot">
        <a class="btn btn-ghost btn-sm" href="/">返回论坛</a>
        <button class="btn btn-primary" id="startBtn">${passed ? '再答一次' : '开始答题'}</button>
      </div>
    </div>`;
    document.getElementById('startBtn').addEventListener('click', () => startExam().catch(handleError));
  };

  const startExam = async () => {
    if (!bank.questions || !bank.questions.length) {
      throw new Error('题库是空的，请联系管理员检查题库文件');
    }
    const count = Math.min(Number(rules.question_count) || 50, bank.questions.length);
    const exam = shuffle(bank.questions).slice(0, count);

    let index = 0;
    let correct = 0;

    const showQuestion = () => {
      const question = exam[index];
      host.innerHTML = `<div class="card composer quiz-card">
        <div class="quiz-progress"><i style="width:${Math.round((index / exam.length) * 100)}%"></i></div>
        <div class="quiz-progress-label">第 ${index + 1} / ${exam.length} 题 · 已答对 ${correct} 题</div>
        <div class="quiz-q">${BB.esc(question.text)}</div>
        <div class="quiz-opts">
          ${question.options
            .map(
              (option, i) =>
                `<button type="button" class="quiz-opt" data-i="${i}"><b>${'ABCD'[i]}.</b> ${BB.esc(option)}</button>`,
            )
            .join('')}
        </div>
        <div id="quizFeedback"></div>
      </div>`;
      host.querySelectorAll('.quiz-opt').forEach((button) => {
        button.addEventListener('click', () => answer(Number(button.dataset.i)));
      });
    };

    const answer = (chosen) => {
      const question = exam[index];
      const isCorrect = chosen === question.answer_index;
      if (isCorrect) correct += 1;
      host.querySelectorAll('.quiz-opt').forEach((button) => {
        const i = Number(button.dataset.i);
        button.disabled = true;
        if (i === question.answer_index) button.classList.add('quiz-opt-correct');
        else if (i === chosen) button.classList.add('quiz-opt-wrong');
      });
      document.getElementById('quizFeedback').innerHTML = `
        <div class="quiz-explain"><b>${
          isCorrect ? T('答对了！') : TF('答错了，正确答案是 {0}', 'ABCD'[question.answer_index])
        }</b>　${BB.esc(question.explanation)}</div>
        <div class="quiz-foot">
          <button class="btn btn-primary" id="nextBtn">${index + 1 >= exam.length ? '查看结果' : '下一题'}</button>
        </div>`;
      document.getElementById('nextBtn').addEventListener('click', () => {
        index += 1;
        if (index >= exam.length) showResult();
        else showQuestion();
      });
    };

    const showResult = () => {
      const score = correct * perQuestion;
      const full = exam.length * perQuestion;
      const passed = score >= passScore;
      host.innerHTML = `<div class="card composer quiz-card">
        <h3>${passed ? '恭喜，答题通过！' : '这次还没通过'}</h3>
        <div class="quiz-score">${score}<span class="muted" style="font-size: 18px"> / ${full} 分</span></div>
        <p class="muted small">答对 ${correct} / ${exam.length} 题${
          passed ? '' : `，需要 ${passScore} 分才能通过，再试一次吧`
        }</p>
        <div class="quiz-foot" id="resultFoot"></div>
      </div>`;

      const foot = document.getElementById('resultFoot');
      if (passed) {
        BB.api('/api/quiz/complete', { method: 'POST', body: { score } })
          .then(() => BB.toast('答题结果已记录到你的账号', 'ok'))
          .catch((error) => BB.toast(error.message || '记录答题结果失败', 'error'));
        const goBack = document.createElement('a');
        goBack.className = 'btn btn-primary';
        goBack.href = safeNext || '/';
        goBack.textContent = safeNext ? '继续刚才的操作' : '回论坛逛逛';
        foot.appendChild(goBack);
      }
      const again = document.createElement('button');
      again.type = 'button';
      again.className = passed ? 'btn btn-ghost' : 'btn btn-primary';
      again.textContent = passed ? '再答一次' : '重新答题';
      again.addEventListener('click', () => startExam().catch(handleError));
      foot.appendChild(again);
      const home = document.createElement('a');
      home.className = 'btn btn-ghost';
      home.href = '/';
      home.textContent = '返回论坛';
      foot.appendChild(home);
    };

    showQuestion();
  };

  renderIntro();
});
