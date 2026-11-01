import crypto from 'node:crypto';
import os from 'node:os';
import net from 'node:net';
import tls from 'node:tls';
import { config } from '../config.js';
import { HttpError } from './http.js';

/**
 * 最小 SMTP 发信客户端（node:net / node:tls，零第三方依赖）。
 * 支持：明文 / 隐式 TLS（465）/ STARTTLS（587），可选 AUTH LOGIN 登录。
 * 只实现发一封纯文本邮件所需的部分，够发验证码邮件就行；
 * 连本机自托管 Postfix（127.0.0.1:25，无认证）也是同一套流程。
 */

/** 把一封邮件组装成 RFC 5322 文本，主题与正文按 UTF-8 编码 */
function buildMessage({ from, to, subject, text }) {
  const encodedSubject = `=?UTF-8?B?${Buffer.from(subject, 'utf8').toString('base64')}?=`;
  // Postfix 对 SMTP 提交的邮件默认不补 Date / Message-ID，缺了容易被判垃圾，自己带上
  const messageIdHost = from.includes('@') ? from.split('@')[1] : os.hostname();
  const messageId = `${Date.now()}.${crypto.randomBytes(6).toString('hex')}@${messageIdHost}`;
  return [
    `From: ${from}`,
    `To: ${to}`,
    `Subject: ${encodedSubject}`,
    `Date: ${new Date().toUTCString().replace(/GMT$/, '+0000')}`,
    `Message-ID: <${messageId}>`,
    'MIME-Version: 1.0',
    'Content-Type: text/plain; charset=UTF-8',
    'Content-Transfer-Encoding: base64',
    '',
    Buffer.from(text, 'utf8').toString('base64'),
  ]
    .join('\r\n')
    .replace(/\r?\n\./g, '\r\n..'); // 正文里的独立点号按 SMTP 规则转义
}

/** 读取一条（或多条拼在一起的）服务器响应，返回 { code, lines } */
function readReply(socket, buffer) {
  return new Promise((resolve, reject) => {
    const done = () => {
      const raw = buffer.join('');
      const lines = raw.split(/\r?\n/).filter(Boolean);
      const last = lines[lines.length - 1] || '';
      const code = Number(last.slice(0, 3));
      // 末行第 4 位是空格才是最后一条；'-' 表示还有后续行
      if (!Number.isFinite(code) || last.slice(3, 4) !== ' ') return;
      resolve({ code, lines, raw });
    };
    const onData = (chunk) => {
      buffer.push(chunk.toString('utf8'));
      done();
    };
    socket.once('data', onData);
    socket.once('error', reject);
    socket.once('close', () => reject(new Error('连接在等待响应时被关闭')));
  });
}

/** 发一条命令并等响应；expected 不符时抛错 */
async function command(socket, buffer, line, expected, label) {
  if (line !== null) socket.write(`${line}\r\n`);
  const reply = await readReply(socket, buffer);
  if (!expected.includes(reply.code)) {
    throw new Error(`${label}失败（SMTP ${reply.code}）：${reply.lines[reply.lines.length - 1]?.slice(4) || ''}`.trim());
  }
  return reply;
}

/** 与 SMTP 服务器完成一次完整发信会话，返回最终响应 */
function smtpSession({ host, port, secure, user, pass, from, to, subject, text }) {
  return new Promise((resolve, reject) => {
    // 本机自托管 Postfix 常配自签名证书：回环连接不校验证书（流量不出本机），
    // 外部服务器默认严格校验，自签名场景可用 SMTP_ALLOW_SELF_SIGNED=1 显式放开
    const loopback = ['127.0.0.1', '::1', 'localhost'].includes(host);
    const rejectUnauthorized = !(loopback || config.smtpAllowSelfSigned);
    const tlsOptions = { servername: host, rejectUnauthorized };
    const connect = secure ? tls.connect : net.connect;
    let socket = connect({ host, port, ...tlsOptions }, () => start().catch(reject));
    socket.setTimeout(15_000, () => {
      socket.destroy();
      reject(new Error('SMTP 服务器响应超时'));
    });
    socket.on('error', reject);

    const buffer = [];
    async function start() {
      const greeting = await readReply(socket, buffer);
      if (greeting.code !== 220) throw new Error(`SMTP 服务器拒收（${greeting.code}）`);

      // 明文端口上如果服务器支持 STARTTLS 就升进 TLS，升级后重新 EHLO
      if (!secure) {
        buffer.length = 0;
        const ehloHost = config.publicOrigin ? new URL(config.publicOrigin).hostname : 'localhost';
        const ehlo = await command(socket, buffer, `EHLO ${ehloHost}`, [250], 'EHLO');
        const supportsStarttls = ehlo.lines.some((line) => line.slice(4).toUpperCase().startsWith('STARTTLS'));
        if (supportsStarttls) {
          await command(socket, buffer, 'STARTTLS', [220], 'STARTTLS');
          // 先清掉明文阶段的临时监听（readReply 挂的 once、上面的 error 处理），
          // 再在原 TCP 连接上叠 TLS；之后 socket 整体换成加密通道
          socket.removeAllListeners();
          const upgraded = tls.connect({ socket, ...tlsOptions }, () => {
            socket = upgraded;
            buffer.length = 0;
            run().catch(reject);
          });
          upgraded.on('error', reject);
          return;
        }
      }
      await run();
    }

    async function run() {
      try {
        const ehloHost = config.publicOrigin ? new URL(config.publicOrigin).hostname : 'localhost';
        await command(socket, buffer, `EHLO ${ehloHost}`, [250], 'EHLO');
        if (user) {
          await command(socket, buffer, 'AUTH LOGIN', [334], 'AUTH');
          await command(socket, buffer, Buffer.from(user, 'utf8').toString('base64'), [334], 'AUTH');
          await command(socket, buffer, Buffer.from(pass || '', 'utf8').toString('base64'), [235], '登录邮件服务器');
        }
        await command(socket, buffer, `MAIL FROM:<${from}>`, [250], '发件人');
        await command(socket, buffer, `RCPT TO:<${to}>`, [250, 251], '收件人');
        await command(socket, buffer, 'DATA', [354], '正文');
        await command(socket, buffer, `${buildMessage({ from, to, subject, text })}\r\n.`, [250], '投递');
        socket.write('QUIT\r\n');
        socket.end();
        resolve();
      } catch (error) {
        socket.destroy();
        reject(error);
      }
    }
  });
}

/**
 * 发一封纯文本邮件。SMTP_HOST 没配时抛 503，提示管理员先去配置。
 * 发信失败统一转成 HttpError(502)，message 直接展示给启动器用户。
 */
export async function sendMail({ to, subject, text }) {
  if (!config.smtpHost) {
    throw new HttpError(503, '邮件服务尚未配置，请联系管理员', 'mail_disabled');
  }
  if (!config.mailFrom) {
    throw new HttpError(503, '发件邮箱尚未配置（MAIL_FROM），请联系管理员', 'mail_disabled');
  }
  try {
    await smtpSession({
      host: config.smtpHost,
      port: config.smtpPort,
      secure: config.smtpSecure,
      user: config.smtpUser,
      pass: config.smtpPass,
      from: config.mailFrom,
      to,
      subject,
      text,
    });
  } catch (error) {
    const detail = error instanceof Error ? error.message : String(error);
    console.error('[论坛] 邮件发送失败：', detail);
    throw new HttpError(502, '验证码邮件发送失败，请稍后再试', 'mail_failed');
  }
}
