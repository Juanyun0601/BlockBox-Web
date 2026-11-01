import fs from 'node:fs';
import path from 'node:path';
import { ROOT_DIR } from '../config.js';

/**
 * 入站答题题库：与启动器共用同一份 quiz_bank.txt（格式约定见启动器的 QuizBank）。
 * 题目之间以空行分隔，每题结构：
 *   题干（可带 “001. ” 题号）
 *   A. 选项 / B. 选项 / C. 选项 / D. 选项
 *   答案：C
 *   解析：……
 * 判分在客户端完成（启动器本地判分、网页在浏览器里判分），服务端只负责
 * 下发题库和记录通过结果，这里解析一次后常驻内存。
 */

const BANK_PATH = path.join(ROOT_DIR, 'server', 'quiz_bank.txt');

/** 答题规则：题数 / 每题分值 / 及格线（与启动器 QuizBank 的常量保持一致） */
export const QUIZ_RULES = {
  question_count: 50,
  points_per_question: 2,
  pass_score: 80,
};

function stripQuestionNumber(line) {
  return line.replace(/^\s*\d{1,3}\s*[.、]\s*/, '').trim();
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

      if (line.startsWith('答案')) {
        const answer = line.split('：')[1]?.trim().toUpperCase() || '';
        if (answer.length === 1 && answer >= 'A' && answer <= 'D') {
          answerIndex = answer.charCodeAt(0) - 65;
        }
        continue;
      }
      if (line.startsWith('解析')) {
        explanation = line.split('：').slice(1).join('：').trim();
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

function loadBank() {
  let raw = '';
  try {
    raw = fs.readFileSync(BANK_PATH, 'utf8');
  } catch (error) {
    console.error('[论坛] 无法读取入站答题题库：', BANK_PATH, error.message);
    return [];
  }
  const questions = parseBank(raw);
  console.log(`[论坛] 入站答题题库加载完成，共 ${questions.length} 道题`);
  return questions;
}

export const quizQuestions = loadBank();
