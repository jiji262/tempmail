# Temp Mail Worker 使用说明

这是一个 Cloudflare Worker，用于：

- 接收 Email Routing 投递的邮件并写入 D1
- 提供临时邮箱地址申请接口
- 提供邮件查询接口
- 在 `/` 提供邮件列表 HTML 页面（点击查看详情）

当前入口文件：`mail.woker.js`

---

## 1. 功能总览

- `POST /admin/new_address`：创建临时邮箱地址，返回 `{ jwt, address }`
- `GET /api/mails`：按 token 拉取邮件列表，返回 `{ results: [...] }`
- `GET /`：HTML 收件箱页面（邮件列表 + 点击查看内容）
- `GET /health`：健康检查

---

## 2. 先配置 D1 数据库（重点）

先去配置 D1 数据库。回到 Cloudflare 主页，在刚刚 compute 下面，有个
`Storage & Databases`，点进去，选择 `D1`，右上角创建。

务必看看这是哪个数据库，记下数据库名和 `database_id`，后面绑定要用。

### 2.1 进入 D1 控制台执行 SQL

进入数据库详情页，点击上方 `控制台`（Console）标签。
下方输入框可执行 SQL。

注意事项：

1. 不要把注释复制进去执行
2. 严格按顺序执行
3. 建议分批粘贴，确保一次成功

### 2.2 首次初始化 SQL（首次执行用这一段）

```sql
CREATE TABLE emails (
  id TEXT PRIMARY KEY,
  source TEXT NOT NULL DEFAULT '',
  address TEXT NOT NULL,
  subject TEXT NOT NULL DEFAULT '',
  content TEXT NOT NULL DEFAULT '',
  timestamp TEXT NOT NULL
);

CREATE INDEX idx_emails_address_timestamp
ON emails (address, timestamp DESC);

CREATE TABLE mailbox_tokens (
  token TEXT PRIMARY KEY,
  address TEXT NOT NULL,
  created_at TEXT NOT NULL,
  expires_at TEXT NOT NULL
);

CREATE INDEX idx_mailbox_tokens_address
ON mailbox_tokens (address);

CREATE INDEX idx_mailbox_tokens_expires_at
ON mailbox_tokens (expires_at);
```

### 2.3 重置数据库 SQL（仅在出错重来时使用）

> 首次执行**不要**跑这段。

```sql
DROP INDEX IF EXISTS idx_emails_address_timestamp;
DROP INDEX IF EXISTS idx_mailbox_tokens_address;
DROP INDEX IF EXISTS idx_mailbox_tokens_expires_at;

DROP TABLE IF EXISTS mailbox_tokens;
DROP TABLE IF EXISTS emails;
```

---

## 3. 必要配置项

Worker 运行依赖以下绑定/变量：

- `DB`（D1 绑定，必须）
- `ADMIN_PASSWORD`（敏感信息，必须）
- `EMAIL_DOMAIN`（可选，但建议设置）
- `TOKEN_TTL_SECONDS`（可选，默认 604800）

建议在 Cloudflare Dashboard 手动配置（你当前需求就是手动配置）。

### 3.1 在 Dashboard 手动配置绑定/变量

1. 进入 Worker 项目
2. `Settings -> Bindings`
3. 添加 D1：
   - Variable name: `DB`
   - 选择你刚创建的 D1 数据库
4. 添加环境变量：
   - `EMAIL_DOMAIN=你的域名`（如 `example.com`）
   - `TOKEN_TTL_SECONDS=604800`（可选）
5. 添加 Secret：
   - `ADMIN_PASSWORD=你自己的管理员密码`

---

## 4. 部署方式

在 `tempmail` 目录执行：

```bash
npx wrangler deploy
```

## 5. 邮件接收（Email Routing）

仅部署 Worker 还不够，还要把域名邮箱路由到该 Worker。

1. 在 Cloudflare 中进入对应域名
2. 找到 `Email` / `Email Routing`
3. 创建路由规则，将目标地址（或 catch-all）转发到本 Worker
4. 确保邮件实际投递到 Worker 的 `email()` 事件

---

## 6. API 使用示例

将下面的 `YOUR_WORKER_URL` 替换为实际地址。

### 6.1 健康检查

```bash
curl -sS https://YOUR_WORKER_URL/health
```

### 6.2 创建临时邮箱地址

```bash
curl -sS -X POST "https://YOUR_WORKER_URL/admin/new_address" \
  -H "content-type: application/json" \
  -H "x-admin-auth: YOUR_ADMIN_PASSWORD" \
  -d '{"name":"demo","domain":"example.com"}'
```

返回示例：

```json
{
  "jwt": "xxxxx",
  "address": "demo@example.com"
}
```

### 6.3 拉取邮件列表

```bash
curl -sS "https://YOUR_WORKER_URL/api/mails?limit=10&offset=0" \
  -H "authorization: Bearer YOUR_JWT"
```

返回示例：

```json
{
  "results": [
    {
      "id": "uuid",
      "source": "from@example.com",
      "address": "demo@example.com",
      "subject": "hello",
      "raw": "邮件原文",
      "timestamp": "2026-02-24T12:00:00.000Z"
    }
  ]
}
```

### 6.4 打开 HTML 收件箱页面

浏览器访问：

```text
https://YOUR_WORKER_URL/
```

---

## 7. 常见问题

### 7.1 `Could not detect a directory containing static files`

原因：没有 `wrangler.toml` 且命令没有指定 Worker 入口脚本。  
处理：使用方案 A，或使用方案 B 的完整命令。

### 7.2 `server misconfigured: ADMIN_PASSWORD missing`

原因：未配置 `ADMIN_PASSWORD` Secret。  
处理：在 Dashboard 的 Worker Secret 中添加该值。

### 7.3 `/api/mails` 返回 401

原因：`Authorization: Bearer <token>` 缺失或 token 过期。  
处理：重新调用 `/admin/new_address` 生成新 token。

---

## 8. 安全建议

- 不要把 `ADMIN_PASSWORD` 写入仓库
- 尽量在生产中限制 `/admin/new_address` 的调用来源
- 定期轮换 `ADMIN_PASSWORD`
- 为 `EMAIL_DOMAIN` 设置固定值，避免创建任意域名地址

