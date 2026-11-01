# 邮箱验证发信 · 需要在 Cloudflare 添加的 DNS 记录

服务器：202.181.26.190（华为云 ECS）
发件人：noreply@mcblockbox.top（服务器本机 Postfix 投递，OpenDKIM 已签名）
DKIM 公钥对应服务器上 `/etc/opendkim/keys/mcblockbox.top/mail.private`，换了密钥要同步改下面的记录。

## 需要添加的 3 条记录（Cloudflare 控制台 → DNS → 添加记录）

### 1. SPF（TXT）

| 字段 | 值 |
|---|---|
| 类型 | TXT |
| 名称 | `@` |
| 内容 | `v=spf1 ip4:202.181.26.190 -all` |
| TTL | 自动 |

### 2. DMARC（TXT）

| 字段 | 值 |
|---|---|
| 类型 | TXT |
| 名称 | `_dmarc` |
| 内容 | `v=DMARC1; p=none; rua=mailto:postmaster@mcblockbox.top` |
| TTL | 自动 |

### 3. DKIM（TXT，一条记录，内容里不要有换行和引号）

| 字段 | 值 |
|---|---|
| 类型 | TXT |
| 名称 | `mail._domainkey` |
| 内容 | 见下（`p=` 后面是一整段连续的公钥） |
| TTL | 自动 |

```
v=DKIM1; h=sha256; k=rsa; p=MIIBIjANBgkqhkiG9w0BAQEFAAOCAQ8AMIIBCgKCAQEA2HjCoAogLB2NM4GkH+LkLiLRd8HFPGLZwi4QOancyQjnOJ4s3mH6qSZpL847NpQzNiOfnBdqljSruhJ9E/8AzP/xpkHbcCkA9GH91u2MUZb7uWd0b4IceAaeSPzxHQNJtt+l8uEdxNXc61AsqeEWTPitQPoy8hAOeBZZX1tqKehO8o/ZYqOzqFijYIdc4JVe8zfmpksSY1q0WHAqizvIHmztcrsfvWwOqVdvSPzJbzfPbUwHBp8wWfJVGcsoEyi/U55mDEgbS/oapMj1CitG1mMBxGIxdgP4oIuI6WUedV12kFmlXmyFDOtdo85fae+jAsPcYM13tk5ZP3A+ymmBNwIDAQAB
```

> Cloudflare 的「电子邮件安全」向导也能生成 DKIM，但那会生成另一套密钥、和服务器上的对不上，
> 请直接用上面这份（它对应服务器上已启用的密钥）。

## 4. PTR 反向解析（不在 Cloudflare，在华为云控制台）

当前 `202.181.26.190` 的反向解析是 `spk.laws.ms`，**必须改成 `mcblockbox.top`**：
华为云控制台 → 弹性云服务器 ECS → 找到这台机器 → 「反向解析」/ rDNS → 设为 `mcblockbox.top`。
PTR 和 Postfix 的 `myhostname`（已设为 mcblockbox.top）一致是各大邮箱收信的硬性检查项。

## 添加完成后的验证

```bash
# 在任意电脑上：
nslookup -type=TXT mcblockbox.top 8.8.8.8        # 能看到 SPF
nslookup -type=TXT _dmarc.mcblockbox.top 8.8.8.8  # 能看到 DMARC
nslookup -type=TXT mail._domainkey.mcblockbox.top 8.8.8.8  # 能看到 DKIM
nslookup 202.181.26.190 8.8.8.8                    # 名称应显示 mcblockbox.top

# 服务器上清掉之前的退信缓存再实测（SSH 到服务器）：
postsuper -d ALL
echo "验证信测试" | sendmail -f noreply@mcblockbox.top 你的真实邮箱
journalctl --no-pager -n 20 | grep postfix    # status=sent 才算成功
```

最后用启动器走一遍：账号设置 → 填邮箱 → 发送验证码 → 收信（先看收件箱再看垃圾箱）→ 填码验证。
