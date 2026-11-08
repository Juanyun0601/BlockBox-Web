import fs from 'node:fs';
import path from 'node:path';
import { ROOT_DIR } from '../config.js';

/**
 * 入站答题题库：中文题库与英文题库各一份。
 *
 * 格式（中英文标签都支持）：
 *   题干（可带 “001. ” 题号）
 *   A. 选项 / B. 选项 / C. 选项 / D. 选项
 *   答案：C   或   Answer: C
 *   解析：……  或   Explanation: ……
 *
 * 判分在客户端完成（启动器本地判分、网页在浏览器里判分），服务端只负责
 * 下发题库和记录通过结果；两份题库启动时各解析一次后常驻内存。
 */

const BANK_PATHS = {
  zh: path.join(ROOT_DIR, 'server', 'quiz_bank.txt'),
  en: path.join(ROOT_DIR, 'server', 'quiz_bank_en.txt'),
};

/** 答题规则：题数 / 每题分值 / 及格线（与启动器 QuizBank 的常量保持一致） */
export const QUIZ_RULES = {
  question_count: 50,
  points_per_question: 2,
  pass_score: 80,
};

function stripQuestionNumber(line) {
  return line.replace(/^\s*\d{1,3}\s*[.、]\s*/, '').trim();
}

/** 取 “答案：C” / “Answer: C” 冒号后的值，中英文冒号都认 */
function afterColon(line) {
  const index = line.search(/[：:]/);
  return index >= 0 ? line.slice(index + 1).trim() : '';
}

function parseBank(raw) {
  const blocks = raw.split(/\n\s*\n/);
  const questions = [];
  const optionRe = /^\s*([A-Da-d])\s*[.、]\s*(.*)$/;

  for (const rawBlock of blocks) {
    const lines = rawBlock.split('\n');
    if (lines.length === 0) continue;

    const text = stripQuestionNumber(lines[0]);
    if (!text) continue;

    const options = ['', '', '', ''];
    let answerIndex = -1;
    let explanation = '';

    for (let i = 1; i < lines.length; i++) {
      const line = lines[i].trim();
      if (!line) continue;

      if (line.startsWith('答案') || /^answer\s*[:：]/i.test(line)) {
        const answer = afterColon(line).toUpperCase();
        if (answer.length === 1 && answer >= 'A' && answer <= 'D') {
          answerIndex = answer.charCodeAt(0) - 65;
        }
        continue;
      }
      if (line.startsWith('解析') || /^explanation\s*[:：]/i.test(line)) {
        explanation = afterColon(line);
        continue;
      }
      const match = optionRe.exec(line);
      if (match) {
        const index = match[1].toUpperCase().charCodeAt(0) - 65;
        if (index >= 0 && index < 4) options[index] = match[2].trim();
      }
    }

    const complete = text && explanation && answerIndex >= 0 && options.every((option) => option);
    if (!complete) {
      console.warn('[论坛] 题库里有格式不完整的题目，已跳过：', text);
      continue;
    }
    questions.push({ id: questions.length, text, options, answer_index: answerIndex, explanation });
  }

  return questions;
}

function loadBank(code) {
  const file = BANK_PATHS[code];
  let raw = '';
  try {
    raw = fs.readFileSync(file, 'utf8');
  } catch (error) {
    console.error(`[论坛] 无法读取${code === 'en' ? '英文' : '中文'}入站答题题库：`, file, error.message);
    return [];
  }
  const questions = parseBank(raw);
  console.log(`[论坛] ${code === 'en' ? '英文' : '中文'}入站答题题库加载完成，共 ${questions.length} 道题`);
  return questions;
}

const banks = {
  zh: loadBank('zh'),
  en: loadBank('en'),
};

/**
 * 按语言挑题库：
 * - zh / zh-CN / zh-TW / zh-Hant → 中文题库
 * - 其他语言 → 英文题库（国际版）
 * - 英文题库缺失或为空时回退中文
 * @param {string} language 语言代码或 Accept-Language 头
 */
export function getQuizBank(language) {
  const raw = String(language || '').trim();
  if (!raw) {
    if (banks.zh.length > 0) return { lang: 'zh', questions: banks.zh };
    return { lang: 'en', questions: banks.en };
  }
  const isChinese = /^zh\b/i.test(raw) || /^zh[-_]/i.test(raw);
  if (!isChinese && banks.en.length > 0) {
    return { lang: 'en', questions: banks.en };
  }
  if (banks.zh.length > 0) {
    return { lang: 'zh', questions: banks.zh };
  }
  return { lang: 'en', questions: banks.en };
}

/** 兼容旧引用：默认中文题库 */
export const quizQuestions = banks.zh;

/** 两份题库的题量，供管理后台或排查用 */
export const quizBankSizes = {
  zh: banks.zh.length,
  en: banks.en.length,
};
