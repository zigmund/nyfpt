# Tradernet API — сводка документации и проверка CORS

Дата исследования: 2026-10-31.

Источники:

- Официальная документация: <https://tradernet.kz/tradernet-api/auth-login> и все 64 раздела из бокового меню. Страница-оболочка подгружает содержимое каждого раздела через `GET /tradernet-api/get-example?id=<slug>`; так и скачивались все разделы.
- PHP-клиент из доки: `https://tradernet.kz/r/PublicApiClient.php.zip` (`PublicApiClient` v2.0.0, «Tradernet Public API V3 transport client»).
- Официальные SDK из раздела «Библиотеки»:
  - Python `tradernet-sdk` 2.2.0 (PyPI, автор Anton Kudelin);
  - PHP `github.com/tradernet-api/TradernetPhpSDK`, включая его `docs/*.md`;
  - Laravel-плагин `github.com/tradernet-api/laravel`.
- Официальный MCP-сервер Tradernet `https://tradernet.kz/mcp/tn` (tn-mcp 1.27.1). Схемы его 61 инструмента получены анонимным вызовом `tools/list`. В описаниях инструментов есть «docs-vs-live» находки самих разработчиков, на них ссылаюсь как **[MCP]**.
- Эмпирические проверки через `curl`, Python `websockets` и настоящий Chrome (страница `https://example.com`, `fetch()`). Ключей не было: в запросах использовались только **фейковые** ключи и SID либо анонимные публичные команды. Торговых команд не вызывал.

Пометки:

- **[ДОКА]** — дословно или близко к тексту документации.
- **[SDK-PY]** / **[SDK-PHP]** — из кода официальных SDK.
- **[ПРОВЕРЕНО]** — проверено запросом.
- **[НЕ УКАЗАНО]** — в документации нет.
- ⚠️ — противоречие или неполнота.

---

## TL;DR для нашего приложения (stateless SPA, ключи в браузере)

1. **Документированный способ авторизации по ключам (API V3: заголовки `X-NtApi-*`, POST с `Content-Type: application/json`) из браузера напрямую НЕ работает.** Сервер (Cloudflare) отвечает на CORS preflight `OPTIONS` статусом `204` **без** `Access-Control-Allow-Origin`, `-Allow-Methods` и `-Allow-Headers`. Браузер блокирует запрос: в Chrome это `TypeError: Failed to fetch` **[ПРОВЕРЕНО]**. Ответы 401/403 тоже приходят без ACAO.
2. Обойти preflight для V3 нельзя:
   - V3 POST с телом не `application/json` возвращает `400 Unexpected request content type` **[ПРОВЕРЕНО]**;
   - ключи в query-параметрах V3 не читает: `401 Invalid credentials`, тогда как те же значения в заголовках дают `403 Invalid api key provided` **[ПРОВЕРЕНО]**;
   - любой кастомный заголовок `X-NtApi-*` делает запрос «непростым».
3. Что **работает** из браузера (simple request, в ответе `200` сервер отражает Origin в `Access-Control-Allow-Origin`):
   - анонимные публичные команды: `getMarketStatus`, `getSecurityInfo`, `tickerFinder`, `getHloc`, `getCrossRatesForDate`, `getTopSecurities` и т. п.;
   - `GET /securities/export` — котировки без авторизации;
   - legacy-эндпоинт `/api/?q={json}` с **SID** в теле или query. SID получают через `authByLogin` (логин и пароль) или SMS.
   
   Авторизации по **ключам** без кастомного заголовка не найдено.
4. Варианты для приложения:
   - **(а)** минимальный stateless CORS-relay в том же nginx (`location /tn/ { proxy_pass https://tradernet.kz/api/; … }` плюс ответ на OPTIONS). Ключи остаются в браузере, nginx ничего не хранит. Самый простой и надёжный путь.
   - **(б)** работать через SID (логин и пароль пользователя в браузере, legacy `q=`-формат). Это хуже по безопасности и UX.
   - **(в)** только публичные данные.
   - Возможно ещё **(г)**: прямая ссылка на отчёт брокера `GET /cabinet/ajax-get-billing-report/?api_key=…&auth_login=…`. Это simple GET, но CORS успешного ответа не проверен, а публичный ключ и логин уходят в URL.
5. WebSocket (`wss://wss.tradernet.kz/`): с чужого Origin рукопожатие проходит, **только если в URL есть `?SID=…` или `?X-NtApi-*`**; без них — `403` **[ПРОВЕРЕНО]**. Авторизация по ключам через query на WS официально не описана: Python SDK так делает, PHP SDK пишет «SID only».

---

## 1. Общее

### 1.1. Базовые URL

| Хост | Что это | Источник |
|---|---|---|
| `https://tradernet.kz` | Кабинет Freedom Finance Kazakhstan (KZ). HTML отдаётся с классом `tm-kz`. | [ПРОВЕРЕНО] |
| `https://trade.almaty-ffin.global` | Тот же KZ-инстанс (тот же класс `tm-kz`, тот же контент). Вся KZ-документация подставляет этот хост в примеры: `https://trade.almaty-ffin.global/api/`. | [ДОКА], [ПРОВЕРЕНО] |
| `https://tradernet.com` | Глобальный кабинет. `DEFAULT_HOST` в PHP-клиенте и SDK, пример в тексте «Ключ API». | [ДОКА], [SDK-PHP] |
| `https://freedom24.com` | Freedom24 (EU). Домен по умолчанию в Python SDK (`DOMAIN = 'freedom24.com'`). | [SDK-PY] |
| `https://tradernet.global` | Ещё один кабинет (в allowlist PHP SDK). | [SDK-PHP] |

- Allowlist PHP SDK: `tradernet.com`, `tradernet.global`, `tradernet.kz`, `freedom24.com` (и их поддомены).
- [ДОКА] «Ключ API»: «Любая из доменных зон может использоваться в качестве конечной точки API».
- ⚠️ [SDK-PHP `docs/authentication.md`]: «API keys live in the cabinet database of a specific domain… A key minted on one domain will fail with `Invalid api key provided` on another». Это противоречит доке.
- **Для KZ-клиента**: `https://tradernet.kz` (эквивалент — `https://trade.almaty-ffin.global`). Совместимость ключей KZ с `.com` и `freedom24` не проверялась (ключей нет).
- Список офисов (reception) с кодами есть в разделе «Список действующих офисов». Какой брокер на каком домене, дока **не указывает**.

Эндпоинты (пути):

- `POST|GET /api/{command}` — **API V3** (текущий, документирован в «Ключ API»);
- `GET|POST /api/` с параметром `q=<JSON>` — **legacy V1** (почти все примеры jQuery в доке: `$.getJSON(".../api/", {q: JSON.stringify({cmd, SID, params})})`);
- `POST /api/v2/cmd/{command}` — **legacy V2** (form-urlencoded `cmd`, `apiKey`, `nonce`, `params` плюс заголовок `X-NtApi-Sig`). Встречается только в JS-примерах `orders-send`, `orders-delete` и `stop-loss`. Эндпоинт жив: `200 {"error":"Invalid signature provided","code":12}` **[ПРОВЕРЕНО]**;
- `GET /securities/export?tickers=A+B&params=c+ltp+…` — публичный экспорт котировок (вкладка REST в разделе «Получение котировки»);
- `GET /cabinet/ajax-get-billing-report/?…` и `GET /cabinet/ajax-get-depositary-billing-report/?…` — отчёты по прямой ссылке;
- `GET /refbooks/{YYYY-MM-DD}/{name}.json.zip` — справочники инструментов (используется Python SDK, в доке **не описано**);
- WebSocket: `wss://wss.tradernet.kz/` (см. §6). ⚠️ Дока для KZ указывает `wss.trade.almaty-ffin.global` — **такого DNS-имени нет** [ПРОВЕРЕНО: `dig` пустой]. Рабочие хосты: `wss.tradernet.kz`, `wss.almaty-ffin.global`, `wss.tradernet.com`, `wss.freedom24.com`.

### 1.2. Версии API

| Версия | Транспорт | Авторизация | Статус |
|---|---|---|---|
| V1 | `GET/POST /api/?q={"cmd":…, "SID":…, "params":{…}}` (form-urlencoded или query) | SID в JSON `q`, или cookie `SID`, или (по тексту доки) заголовки `X-NtApi-PublicKey` + `X-NtApi-Sig` | Legacy, работает [ПРОВЕРЕНО]. Большинство примеров доки в этом формате. |
| V2 | `POST /api/v2/cmd/{cmd}`, form-urlencoded `cmd, apiKey, nonce, params[...]` + заголовок `X-NtApi-Sig` | HMAC, алгоритм пресайна в **текущей доке не описан** (ссылки на «Ключ API, параграф 4» ведут на страницу, где его уже нет) | Legacy. ⚠️ Фразы «HTTPS POST (Для API V2)» встречаются во многих разделах. |
| V3 | `/api/{cmd}`; POST/PUT — тело JSON, GET — query | Заголовки `X-NtApi-PublicKey`, `X-NtApi-Timestamp`, `X-NtApi-Sig` | Текущая; описана в «Ключ API», используется обоими SDK. |

PHP-клиент из доки называется «Tradernet Public API V3 transport client». В PHP SDK написано: «This matches Tradernet `V3AuthenticatorMiddleware`».

### 1.3. Формат запросов V3

- URL: `https://tradernet.kz/api/{command}`. Имя команды — в пути, регистр важен (`GetAllUserTexInfo`, `GetListTariffs` с заглавной [MCP]).
- **POST/PUT**: тело — JSON (это и есть `params`, **без** обёртки `cmd`/`params`), заголовок `Content-Type: application/json` обязателен. Иначе `400 {"error":"Unexpected request content type"}` [ПРОВЕРЕНО].
- **GET**: параметры в query string. PHP SDK использует Guzzle `query` (это `http_build_query`, массивы как `a[0]=x&a[1]=y`). Проверено: `GET /api/getCrossRatesForDate?base_currency=USD&currencies[0]=KZT&currencies[1]=EUR&date=2026-10-01` → `{"rates":{"KZT":440.86,"EUR":0.88511241}}`.
- Оба SDK по умолчанию шлют **всё POST**.
- Ответ — всегда JSON. Ошибки бывают в ключах `error`, `errMsg` и `code` (см. §4).
- Опциональные cookies: `lang=<iso639-1>` (язык ответа) и `SID=<sid>` [SDK-PHP]. ⚠️ [SDK-PHP]: «Server-side auth is effectively `tryBySid() ?: tryByApiKey()`. If a SID cookie is present, it wins».

### 1.4. Формат запросов V1 (legacy)

```
GET  https://tradernet.kz/api/?q={"cmd":"getMarketStatus","params":{"market":"*"}}
POST https://tradernet.kz/api/   (application/x-www-form-urlencoded)  q={"cmd":"getPositionJson","SID":"<sid>","params":{}}
```

- SID: в JSON (`"SID": "..."`), в cookie `SID` или в заголовке `Cookie: SID=…; language=en` (пример cURL в разделе «Справочник бумаг»).
- В ряде разделов указан `HTTPS GET`, в других `HTTPS POST`. Сервер принимает оба способа для чтения [ПРОВЕРЕНО на `getMarketStatus`, `getPositionJson` с фейковым SID].

---

## 2. Авторизация и подпись

### 2.1. Способы авторизации

1. **Пара API-ключей (V3)** — основной способ. Ключи генерируются в кабинете: «Ключ API» → `/tradernet-api/auth-api`, нужна авторизация. Секрет показывается один раз [ДОКА mcp].
2. **SID-сессия**: `authByLogin` (логин и пароль) или `getAuthSms` + `authBySms`. Возвращается `SID`; `rememberMe: 1` даёт сессию на 2 недели. SID нужен для WebSocket-подписок на портфель, приказы и сессии (по доке) и для части команд (`getSidInfo`, `getOPQ`, `getAnketa`, `getUserInfo`, `getBrokerReport` и `getDepositaryReport` помечены `requiresSid` в PHP SDK). При этом [MCP] вызывает `getBrokerReport` по HMAC.
3. **API-ключ в URL** только для отчётов по прямой ссылке (§5.12).

### 2.2. Подпись V3 — пошагово

**Дословно из доки** («Ключ API», RU):

> Каждый запрос должен быть подписан. Подпись представляет собой хеш HMAC-SHA256 полезной нагрузки запроса, объединенный с текущей меткой времени Unix в секундах, с использованием вашего закрытого ключа в качестве секрета. Правила подписи различаются в зависимости от метода HTTP:
> - Для запросов с телом (POST, PUT) отправляйте параметры в формате JSON с заголовком Content-Type: application/json и вычисляйте подпись на основе этого JSON-тела, за которым следует метка времени.
> - Для GET-запросов параметры передаются в строке запроса, а подпись вычисляется только по метке времени.
>
> Обязательные заголовки:
> - `X-NtApi-PublicKey` — ваш публичный API-ключ.
> - `X-NtApi-Sig` — описанная выше сигнатура HMAC-SHA256.
> - `X-NtApi-Timestamp` — Используется та же метка времени Unix, что и при создании подписи. Каждый последующий запрос должен предоставлять актуальную (свежую) метку времени.

Алгоритм:

1. `ts = floor(Date.now()/1000)` — Unix-время в **секундах**, десятичной строкой.
2. **POST/PUT**:
   - `body = JSON.stringify(params)` — те **же байты**, что уйдут в теле;
   - `message = body + ts` — простая конкатенация без разделителя.
   
   **GET**: `message = ts`. Query **не** подписывается.
3. `sig = HMAC_SHA256(key = secret (UTF-8), msg = message (UTF-8))` в **hex, нижний регистр** (PHP `hash_hmac` по умолчанию и Python `.hexdigest()`; в Node-примере `.digest('hex')`).
4. Заголовки: `X-NtApi-PublicKey: <public>`, `X-NtApi-Timestamp: <ts>`, `X-NtApi-Sig: <sig>`, плюс для POST `Content-Type: application/json`.

**Сериализация параметров и вложенные объекты.** Для V3 нет никакой сортировки и канонизации: подписывается **сырое тело** как есть. Вложенные объекты и массивы — обычный JSON внутри тела. Главное — подписывать ровно ту строку, которая отправляется.

- Python SDK: `json.dumps(params, separators=(',', ':'))`. Компактно, `ensure_ascii=True`, кириллица экранируется как `\uXXXX`. Пустые params дают `"{}"`.
- PHP SDK: `json_encode(..., JSON_UNESCAPED_UNICODE | JSON_UNESCAPED_SLASHES)`. Пустые params дают **пустую строку**, тело пустое, подписывается только `ts`.
- PHP-клиент из доки: `json_encode($data)` (с экранированием), пустые params тоже дают `''`.

Отсюда вывод, что сервер верифицирует по сырому телу (разные SDK сериализуют по-разному, и оба работают). ⚠️ Явно в доке это **не сказано**.

**Пример из доки (Node.js) дословно:**

```js
const crypto = require('crypto');
const axios = require('axios');

const publicKey = '';
const privateKey = '';

const timeStamp = Math.floor(Date.now() / 1000).toString();
const payload = JSON.stringify({
    a: 10,
    b: 'foo',
});

const headers = {
    'Content-Type': 'application/json',
    'X-NtApi-PublicKey': publicKey,
    'X-NtApi-Timestamp': timeStamp,
    'X-NtApi-Sig': generateSignature(payload + timeStamp),
};

function generateSignature (data) {
    return crypto
        .createHmac('sha256', privateKey)
        .update(data)
        .digest('hex');
}

async function callApi (command, payload, headers) {
    return await axios.post(
        `https://tradernet.com/api/${command}`,
        payload,
        { headers },
    );
}

callApi(payload, headers).then((response) => console.log(response.data));
```

⚠️ В примере баг: `callApi(payload, headers)` вызывается без `command`.

**Пример из доки (PHP, ядро):**

```php
if ($method === 'POST' || $method === 'PUT') {
    $data = $data ? json_encode($data) : '';
    $signatureData = $data . $timestamp;
    $options = [RequestOptions::BODY => $data];
    $headers = ['Content-Type' => 'application/json'];
} else {
    $signatureData = (string) $timestamp;
    $options = [RequestOptions::QUERY => $data];
    $headers = [];
}
$signature = hash_hmac('sha256', $signatureData, $this->apiSecretKey);
// headers: X-NtApi-PublicKey, X-NtApi-Sig, X-NtApi-Timestamp
```

**WebCrypto-эквивалент** (для справки, не из доки):

```js
async function sign(secret, message) {
  const enc = new TextEncoder();
  const key = await crypto.subtle.importKey('raw', enc.encode(secret), {name:'HMAC', hash:'SHA-256'}, false, ['sign']);
  const mac = await crypto.subtle.sign('HMAC', key, enc.encode(message));
  return [...new Uint8Array(mac)].map(b => b.toString(16).padStart(2,'0')).join('');
}
// const ts = String(Math.floor(Date.now()/1000)); const body = JSON.stringify(params);
// sig = await sign(secret, body + ts)
```

**Неоднозначности подписи V3:**

- ⚠️ Допустимое окно расхождения timestamp — **[НЕ УКАЗАНО]** («свежая метка»). Защищён ли сервер от replay при одинаковом ts — **[НЕ УКАЗАНО]**.
- ⚠️ Nonce в V3 отсутствует. В V1/V2-разделах (`getBrokerReport`, `getDepositaryReport`) упоминается `nonce`: «Рекомендуем использовать текущий timestamp… Подробнее на странице «Ключ API», параграф 4». Этого параграфа больше нет.
- ⚠️ GET подписывает только timestamp, query не защищён подписью (так в доке).
- ⚠️ В разделах `broker-report` и `depositary-report` написано: «Для API V1 обязательно передавать заголовок X-NtApi-PublicKey… можно передавать в заголовке X-NtApi-Sig hash запроса». Как считать этот hash для V1, не описано.
- ⚠️ Python-примеры в разделах используют несуществующий в текущей доке модуль `PublicApiClient` с `PublicApiClient().V1/V2` и `sendRequest(...)`. Ссылки `/tradernet-api/public-api-client` и `/tradernet-api/python-sdk` возвращают пустой раздел (`get-example` отдаёт 1 байт).
- Устаревшая схема V2 (sorted `key=value&…` пресайн + HMAC в `X-NtApi-Sig`, POST на `/api/v2/cmd/{cmd}`) в текущей доке не описана. Следы: функции `str_from_dict` / `http_build_query` в `tradernet/common/string_utils.py` Python SDK (сортированные `key=value&…`, рекурсивно для вложенных) — для V3 они не используются.

### 2.3. Авторизация по SID

```
POST /api/  q={"cmd":"authByLogin","params":{"login":"…","password":"…","rememberMe":1,"getAccounts":false,"userId":1234}}
```

Параметры: `login`, `password`, `rememberMe` (int|null, 2 недели), `getAccounts` (bool, вернуть список аккаунтов на логине), `viewOnlyMode` (bool), `userId` (int, выбрать аккаунт).

Ответ:

```json
{"success":true,"logged":true,"SID":"…","isSecuritySessionOpened":false,"userId":1234,"real":true,"account_type":"brokerage",
 "reception_country":"EU","reception_code":"EU","reception_title":"Freedom Finance",…}
```

SMS-вариант:

1. `getAuthSms {tel:"+7…"}` → `{auth_code_id, auth_code_length}`.
2. `authBySms {authCodeId, sms, rememberMe, getAccounts, viewOnlyMode, userId}`.

⚠️ PHP SDK шлёт `getAuthSms` с параметром `phone`, дока — `tel`.

Сессии безопасности (SMS/Telegram/push OTP для торговли): `getSecuritySessionCode` → `checkSecuritySessionCode {validationKey}`, список — `getSecuritySessions`. [MCP]: «NOT REQUIRED for HMAC-keypair trading — the HMAC signature is the second factor». В разделах `orders-send` и `orders-delete`: «вначале надо открыть сессию с помощью метода getAuthInfo».

[SDK-PHP]: «Auth endpoints are rate-limited (~5 req/min)».

---

## 3. CORS

### 3.1. Что говорит дока

В доке нет ни слова про CORS, Origin или Access-Control.

- Единственные намёки — jQuery-примеры с `xhrFields: {withCredentials:true} // Параметр для кросс-доменного запроса` и заголовками `'X_REQUESTED_WITH'`, `'Nt-Jqp': true`.
- Все примеры для «Браузера» — jQuery `$.getJSON/$.post` на legacy `/api/?q=`.
- Для V3 есть только серверные примеры (PHP, Node, Python).

### 3.2. Эмпирическая проверка (сырые заголовки)

Шум Cloudflare (`report-to`, `nel`, `cf-ray`, `date`, `strict-transport-security`) и огромный `content-security-policy` вырезаны. Заголовков `access-control-*` в вырезанном не было.

**A. Preflight для V3 с заголовками подписи** (одинаково на `tradernet.kz`, `tradernet.com`, `trade.almaty-ffin.global`, `freedom24.com`; Origin пробовался `https://example.com`, `https://tradernet.kz`, `http://localhost:8080`, `null`):

```
$ curl -si -X OPTIONS https://tradernet.kz/api/getSidInfo \
    -H 'Origin: https://example.com' \
    -H 'Access-Control-Request-Method: POST' \
    -H 'Access-Control-Request-Headers: content-type,x-ntapi-publickey,x-ntapi-sig,x-ntapi-timestamp'
HTTP/2 204
server: cloudflare
expires: Thu, 31 Dec 2037 23:55:55 GMT
cache-control: max-age=315360000
access-control-max-age: 604800
cf-cache-status: DYNAMIC
```

Нет `Access-Control-Allow-Origin`, `-Allow-Methods` и `-Allow-Headers`, значит **preflight не проходит**. То же для:

- `Access-Control-Request-Headers: x-requested-with`;
- запроса без ACRH;
- `/api/`, `/api/v2/cmd/…`, `/cabinet/ajax-get-billing-report/`;
- HTTP/1.1 с браузерным User-Agent и `Sec-Fetch-*`.

**B. Обычный запрос без ключей (ошибка авторизации):**

```
$ curl -si https://tradernet.kz/api/getSidInfo -H 'Origin: https://example.com'
HTTP/2 401
content-type: application/json; charset=UTF-8
cache-control: no-cache, private
x-content-type-options: nosniff
{"error":"Invalid credentials","code":null}
```

Нет ACAO. С фейковыми `X-NtApi-*`: `HTTP/2 403 … {"error":"Invalid api key provided","code":null}`, тоже без ACAO.

**C. Успешный анонимный запрос (V3 path, GET):**

```
$ curl -si 'https://tradernet.kz/api/getMarketStatus?market=*' -H 'Origin: https://example.com'
HTTP/2 200
content-type: application/json; charset=UTF-8
cache-control: no-cache, private
access-control-allow-origin: https://example.com
access-control-allow-headers: Nt-Jqp,X-Requested-With,Authorization
vary: accept-encoding
{"result":{"markets":{"t":"2026-10-31 18:14:29","m":[…]}}}
```

Origin отражается. `Access-Control-Allow-Credentials` **нет**, значит cookie (`SID` в cookie) из браузера кросс-доменно не передать. Заголовки `access-control-*` есть во **всех ответах со статусом 200**, включая бизнес-ошибки (`{"error":"Invalid session ID","code":5}` на legacy `/api/`), и **отсутствуют на 4xx**.

**D. Варианты в обход preflight:**

| Запрос | Результат |
|---|---|
| V3 POST `application/x-www-form-urlencoded` или `text/plain` | `400 {"error":"Unexpected request content type"}` |
| V3 GET с `?X-NtApi-PublicKey=…&X-NtApi-Timestamp=…&X-NtApi-Sig=…` (фейк) | `401 Invalid credentials` (параметры игнорируются; с заголовками было бы 403 `Invalid api key provided`) |
| V2 POST form `cmd,apiKey,nonce` (+ `sig` в теле), без заголовков | `200 {"error":"Invalid signature provided","code":12}` + ACAO. С фейковым ключом не отличить, принимается ли подпись из тела. **Не проверено.** |
| V1 `/api/?q={cmd,SID,params}` form POST, фейковый SID | `200 {"error":"Invalid session ID","code":5}` + ACAO, то есть simple request работает |
| `GET /securities/export?tickers=AAPL.US+KSPI.KZ&params=c+ltp+pp+x_curr` | `200` + ACAO, реальные котировки без авторизации |
| `GET /cabinet/ajax-get-billing-report/?…&api_key=test&auth_login=…` | `403 {"error":"API ключ не найден"}` без ACAO. Успешный ответ с реальным ключом **не проверен**. |

**E. Проверка в реальном Chrome** (страница `https://example.com`, `fetch()`):

```
v3 POST json + X-NtApi (fake keys)      => FAIL TypeError: Failed to fetch
v3 GET + X-NtApi headers (fake keys)    => FAIL TypeError: Failed to fetch
v3 GET anonymous getMarketStatus        => OK 200 {"result":{"markets":…
v3 GET anonymous getSecurityInfo        => OK 200 {"id":"KSPI.KZ",…
v3 GET getSidInfo no auth (401)         => FAIL TypeError: Failed to fetch
legacy POST form q= with fake SID       => OK 200 {"error":"Invalid session ID","errMsg":"Invalid session ID","code":5}
securities/export                       => OK 200 [{"c":"KSPI.KZ","ltp":42570}]
```

### 3.3. Вывод

- **Подписанные ключами вызовы V3 из браузера напрямую невозможны.** Preflight без ACAO → браузер не отправит запрос. Кроме того, даже 4xx-ответы пришли бы без ACAO, и текст ошибки было бы не прочитать.
- Анонимные публичные команды (GET без кастомных заголовков) и legacy V1 с SID в теле работают.
- Гипотеза «CORS проблем не создаст» **неверна** для ключей. Нужен релей. Минимальный вариант — в том же nginx (stateless, ключи не хранит):

```nginx
location /tn/ {
    if ($request_method = OPTIONS) {
        add_header Access-Control-Allow-Origin  $http_origin always;   # или свой origin
        add_header Access-Control-Allow-Methods "GET, POST" always;
        add_header Access-Control-Allow-Headers "content-type,x-ntapi-publickey,x-ntapi-sig,x-ntapi-timestamp" always;
        add_header Access-Control-Max-Age 86400 always;
        return 204;
    }
    proxy_pass https://tradernet.kz/api/;
    proxy_ssl_server_name on;
    proxy_set_header Host tradernet.kz;
    proxy_set_header Origin "";
}
```

При same-origin (SPA и `/tn/` на одном хосте) CORS-заголовки вообще не нужны. Cloudflare может фильтровать User-Agent у проксируемых запросов: PHP SDK пишет, что «Cloudflare… rejects well-known HTTP library agents» (это про WS). Для HTTP через nginx не проверялось.

---

## 4. Лимиты, ошибки, неверная подпись

### 4.1. Лимиты частоты

- [ДОКА] Только в разделе «Справочник бумаг» (`getAllSecurities`): «Количество разрешенных запросов в минуту: 10».
- [SDK-PHP `docs/security.md`]: «Auth endpoints are rate-limited (~5 req/min)». HTTP `429` с опциональным `Retry-After`; SDK один раз ретраит идемпотентные запросы при `Retry-After ≤ 5`.
- [MCP] `getAllSecurities`: «Returns at most 10 instruments per call (take 1..10)… Rate-limited — back off on 429». `getStockQuotesJson`: MCP сам ограничивает 200 тикерами на вызов (это ограничение MCP, не сервера).
- Остальные лимиты — **[НЕ УКАЗАНО]**. Эмпирически не проверялось (чтобы не провоцировать бан).

### 4.2. Формат ошибок

Встречающиеся формы:

```json
{"errMsg":"Bad json","code":2}                              // «Общая ошибка» (V1)
{"error":"Пользователь не найден","code":7}                 // «Ошибка метода»
{"code":5,"error":"Exchange is missing","errMsg":"Exchange is missing"}
{"code":12,"errorMsg":"…","error":"…"}                      // delTradeOrder: ключ errorMsg (!)
{"error":"Validation failed","code":400}                    // V3-разделы новостей
{"error":"Новость не найдена","code":404}
{"error":"Invalid credentials","code":null}                 // V3, HTTP 401
{"error":"Invalid api key provided","code":null}            // V3, HTTP 403
{"error":"Unexpected request content type","code":null}     // V3, HTTP 400
{"alerts":[{"error":"Instrument not found"}]}               // getAlertsList
{"allowed":0,"restriction":"…"}                             // checkAllowedTickerAndBanOnTrade
```

[SDK-PHP]: «Falsy / empty "error" means success on several Tradernet endpoints». То есть `error: ""`, `0` или `null` — не ошибка. Ошибкой считается непустой `error` (строка или массив) или непустой `errMsg`.

Коды из доки и проверок (кодовой таблицы в доке **нет**):

| code | Текст | Где |
|---|---|---|
| 0 | «Некорректный идентификатор операции…», «Не идентифицирован тип безопасности» | putTradeOrder, delTradeOrder |
| 1 | `Param 'q' must be an array`, `No "params" key in request object`, «Вы пытаетесь подать приказ за клиента…» | общее, putStopLoss |
| 2 | `Bad json`, `Unsupported query method`, `Bad parameters` | общая ошибка |
| 5 | `Exchange is missing`, «Не указано обязательное поле 'ticker'», `Invalid session ID` [ПРОВЕРЕНО] | валидация |
| 7 | «Пользователь не найден» | методы |
| 12 | `Invalid credentials` (V1), `Invalid signature provided` (V2) [ПРОВЕРЕНО], «Отмена приказа возможна только по поручению…» | авторизация |
| 14 | `Something wrong, service unavailable` | getMarketStatus |
| 18 | `Exec wrong` | getOrdersHistory |
| 19 | `{tarifs:false, code:19}` — пусто | GetListTariffs [MCP] |
| 109 | «No param 'time_period' is set…» | getBrokerReport |

HTTP-статусы:

- V3 отдаёт реальные 400/401/403/429.
- V1/V2 отдают бизнес-ошибки с HTTP 200 [ПРОВЕРЕНО].
- WebSocket: `["error",{"error":"Access to portfolio subscription denied","subscription":"portfolio","code":"unauthenticated"}]` [ПРОВЕРЕНО].

### 4.3. Неверная подпись

- V3 с несуществующим публичным ключом: `HTTP 403 {"error":"Invalid api key provided","code":null}` [ПРОВЕРЕНО].
- V3 без заголовков: `HTTP 401 {"error":"Invalid credentials","code":null}` [ПРОВЕРЕНО].
- V3 с верным ключом и неверной подписью: в доке **[НЕ УКАЗАНО]**. [MCP §IX] перечисляет сообщение `Invalid signature provided` («Перевыпустите пару ключей»). Ожидаемо 401 или 403, не проверено.
- Устаревший timestamp: **[НЕ УКАЗАНО]**, не проверено.
- V2: `HTTP 200 {"error":"Invalid signature provided","errMsg":"Invalid signature provided","code":12}` [ПРОВЕРЕНО].

---

## 5. Справочник команд

Обозначения:

- **V3-cmd** — имя команды для `/api/{cmd}`.
- «Публичная» — работает без авторизации [ПРОВЕРЕНО] через V3 GET и V1 `q=`.
- Тип авторизации по [MCP]: HMAC, SID или plain.
- Формат примеров запроса ниже — тело V3 (= `params` V1).

### 5.1. Авторизация и пользователь

| cmd | Назначение | Параметры | Ответ (сокр.) |
|---|---|---|---|
| `authByLogin` | Логин и пароль → SID | `login`*, `password`*, `rememberMe` int, `getAccounts` bool, `viewOnlyMode` bool, `userId` int | `{success, logged, SID, userId, real, account_type, reception_*…}` |
| `getAuthSms` | Отправить SMS для входа | `tel`* (международный, с `+`) ⚠️ PHP SDK: `phone` | `{auth_code_id, auth_code_length}` |
| `authBySms` | Вход по SMS | `authCodeId`*, `sms`*, `rememberMe`, `getAccounts`, `viewOnlyMode`, `userId` | как authByLogin |
| `getSidInfo` | Инфо о текущей сессии | — (SID) | `{SID, user_id}`; ошибка `{error:"Пользователь не найден",code:7}` |
| `getOPQ` | «Начальный объект»: котировки, портфель, приказы, рынки, сессии, `userInfo`, `userOptions`, `userLists`, `homeCurrency` в одном | — (SID; PHP SDK `requiresSid`) | `{OPQ:{rev, quotes:{q:[…]}, ps:{loaded, acc:[…], pos:[…]}, orders:{loaded, order:[]}, sess:[], markets:{markets:{t,m:[…]}}, homeCurrency, userLists, userInfo:{id, login, firstname, …, tariffDetails}, userOptions}}` |
| `getAuthInfo` | Инфо об аккаунте по ключам; «открытие сессии» перед `putTradeOrder` в старых примерах | — | **[НЕ УКАЗАНО]**. В JS-примере проверяется `responseText.sess_id`. |
| `GetAllUserTexInfo` | Полный профиль/KYC (PII) [SDK-PY, MCP] | — | `{data:{…}}` [MCP]. В доке **нет раздела**. |
| `GetAllAnketInfo`, `getAnketa`, `getUserInfo` | Анкета, профиль [MCP/SDK-PHP] | — | В доке нет. |
| `getConnectedUsersAssets` | Связанные счета и их активы [MCP] | — | `{receptions, users:[{user_id, trader_systems_id, auth_login, account_type…}]}`. В доке нет. |
| `switchToConnectedUser` | Переключить SID на связанный счёт [MCP] | `user_id` / `trader_systems_id` / `auth_login` | В доке нет. |
| `getSecuritySessions` | Открытые сессии безопасности | — | `[{id, owner_login, user_login, safety_type_id, key_current, start_datetime, expire_datetime, expire, ip, ip_client}]` или `[]` |
| `getSecuritySessionCode` | Отправить OTP для сессии безопасности | `{}` | `{channel:"sms"\|"telegram"\|"push", delay, isRepeatAvailable, isInputAvailable, isSent, texts:{…}}` |
| `checkSecuritySessionCode` | Подтвердить OTP | `validationKey`* | `{success, isAttemptAvailable, sessions:[…], texts}` |

Для дашборда «информация о пользователе/счёте» без SID разумнее всего `getPositionJson` (портфель) и `getConnectedUsersAssets`; `getOPQ` требует SID (по PHP SDK).

### 5.2. Портфель — `getPositionJson` (подробно)

- [ДОКА] «HTTPS POST (для API V2)», `{"cmd":"getPositionJson","params":{}}`. Параметров нет.
- [MCP] Поддерживаются `client_auth_login`, `client_trader_systems_id` и `client_user_id` для связанных счетов. Как они передаются на проводе, в доке **не указано**.
- ⚠️ Структура ответа в доке противоречива: пример показывает `{key, acc:[…], pos:[…]}` на верхнем уровне, таблица — `result (array)`, typedef — `{ps:{acc,pos}}`. [MCP]: «Unwrap `response['result']['ps']` → `{acc, pos, loaded, key}`». Рекомендация: читать `r.result?.ps ?? r.ps ?? r`.
- Числа часто строками: `".00000000"`.

`acc[]` (денежные позиции по валютам):

| поле | смысл |
|---|---|
| `curr` | валюта |
| `currval` | курс к валюте счёта |
| `s` | свободные средства |
| `forecast_in`, `forecast_out` | прогноз ввода и вывода |
| `t2_in`, `t2_out` | T+2 поступления и списания |

`pos[]` (бумажные позиции):

| поле | смысл |
|---|---|
| `i` | тикер |
| `t` | тип |
| `k` | — (не описано) |
| `q` | количество |
| `s` | — (не описано) |
| `fv` | коэффициент ГО |
| `curr` | валюта позиции |
| `currval` | курс |
| `name`, `name2` | названия |
| `open_bal` | балансовая стоимость позиции |
| `mkt_price` | рыночная цена |
| `market_value` | стоимость актива |
| `bal_price_a` / `price_a` | балансовая цена открытия |
| `profit_close` | прибыль на конец прошлого дня |
| `profit_price` | текущая прибыль |
| `close_price` | цена закрытия |
| `vm` | вариационная маржа |
| `go` | ГО |
| `acc_pos_id` | ID позиции |
| `accruedint_a` / `acd` | НКД |
| `base_currency` | базовая валюта |
| `face_val_a` | номинал |
| `scheme_calc` | T0/T1/T2 |
| `instr_id` | ID инструмента |
| `Yield` | доходность |
| `issue_nb` | ISIN |
| `trade[]` | `{trade_count}` |

⚠️ В getOPQ-примере `"instr_id" (int) : ,` — битый JSON.

[ПРОВЕРЕНО 2026-11-01, воскресенье, Task 42] В выходной брокер «перекатывает» `close_price`: у
бумаг `.EU` и `_KZ.KZ` `close_price` = `mkt_price` (изменение за день по позиции выглядит как 0);
у `.US` `close_price` = регулярное закрытие пятницы, а `mkt_price` = последняя пост-маркет
сделка. Поэтому `close_price` не годится как «предыдущее закрытие» вне сессии: приложение берёт
его только последним запасным вариантом (см. §5.3 и docs/CALCULATIONS.md).

### 5.3. Котировки

- **`getStockQuotesJson`** — снимок котировок. Требует авторизации: анонимно `401` [ПРОВЕРЕНО].
  - Параметр `tickers`: ⚠️ в доке в JS-примере это массив `["AAPL.US","F.US"]`; в PHP-примерах — строка `'AAPL.US'` или массив; в SDK — строка через запятую `'AAPL.US,T.US'`.
  - Ответ: `{result:{q:[{c, ltr, name, name2, bbp, bbs, bbc, bbf, bap, bas, bac, baf, pp, op, ltp, lts, ltt, chg, pcp, ltc, mintp, maxtp, vol, vlt, yld, acd, fv, mtd, cpn, cpp, ncd, ncp, dpb, dps, trades, min_step, step_price, strike_price, kind, type, mrg…}]}}`.
  - ⚠️ В PHP-примере числа с запятой (`'147,39'`).
  - [ПРОВЕРЕНО 2026-11-01, воскресенье, Task 42] `chg` и `pcp` верны для всех рынков: `ltp − chg` =
    закрытие предыдущей сессии (совпадает с дневными свечами); в выходной `ltp` у `.EU` и KASE —
    закрытие пятницы, у `.US` — последняя пост-маркет сделка пятницы, `chg` считается от
    закрытия четверга. `pp` у бумаги `.EU` **неверный**: у ETF `.EU` `ltp − chg` совпал с закрытием
    предыдущей сессии, а `pp` был на ~2.5% ниже него (у другого — на ~9% выше); у `.US` и `.KZ`
    `pp` согласован с `chg`. Приложение берёт предыдущее закрытие как `ltp − chg`, затем `pp`, затем из
    `pcp` (`calc/live.js` `quotePrevClose`). Индекс (`SP500.IDX`) по REST приходит из одних нулей
    (`ltp` 0, `pp` 0) — такая котировка «неизвестна», деления на ноль нет.
  - ⚠️ Описание `bac` в разделе «Получение котировки» скопировано с `ltc`.
  - ⚠️ «ГО покупки»: в одном списке `dpd`, в другом `dpb`.
  - Раздел в доке не называет имени команды в теле — только в примерах.
- **`GET /securities/export?tickers=T1+T2&params=f1+f2`** — публичная альтернатива, [ПРОВЕРЕНО] с CORS. Python SDK: до 100 тикеров за запрос, тикеры и поля через пробел.
- **WebSocket `quotes`** — см. §6.
- **`getSecurityInfo`** — карточка тикера, публичная [ПРОВЕРЕНО].
  - Параметры: `ticker`* (один), `sup` bool («Формат СУП или торговой системы»). [MCP]: `sup=true` даёт ~11 статических полей, `false` — ~141 поле полной котировки.
  - Ответ [ПРОВЕРЕНО]: `{"id":"KSPI.KZ","nt_ticker":"KSPI.KZ","short_name":"АО \"KASPI.KZ\"","default_ticker":"KSPI","code_nm":"KSPI","currency":"KZT","min_step":"0.01000000","lot":"1.00000000","mkt_name":"KASE","firstDate":"07.23.2018","mrkt":{"mkt_id":30000000010,"p":…,"post":…,"tz":…,"dt":…,"o":…,"c":…,"st":…}}`.
  - ⚠️ `firstDate` в формате MM.DD.YYYY (07.23.2018), в доке пример `'02.01.1990'` — формат не описан.
  - ⚠️ Описание в доке: «Метод получения исторической информации по котировке (свечи)» — копипаст.
- **`tickerFinder`** — поиск, не более 30 результатов. Публичная [ПРОВЕРЕНО].
  - Параметр `text`; поиск на бирже: `"text":"<ticker>@<market>"` (MCX, FORTS, FIX, UFORTS, UFOUND, EU, KASE).
  - Ответ: `{found:[{instr_id, nm, n, ln, t (тикер), isin, type, kind, tn, code_nm, mkt_id, mkt, x_curr, base_currency, min_step, x_lot, …}]}`.
  - type/kind: 1/1 обыкн. акции, 1/2 прив., 1/7 паи, 2 облигации, 3 фьючерс, 5 индекс, 6/1 деньги, 6/8 крипто, 8–10 репо.
  - [MCP]: результаты ограничены «tradeable universe» вызывающего.
  - [ПРОВЕРЕНО 2026-11-01, Task 38]: `nm` == `n` — отображаемое имя; `ln` чаще `null` или имя эмитента, обрезанное на полуслове; `code_nm` — тикер без суффикса (`DIA`, `NVDA_KZ`); `t` — полный тикер; есть `mkt` и `x_curr`. Поиск нечёткий (в выдаче бывают слабо похожие бумаги). Приложение берёт имя `nm` → `n` → `ln`, подпись карточки — `code_nm`.
- **`getAllSecurities`** — справочник бумаг; авторизация (SID по доке, HMAC по MCP); **10 запросов в минуту**.
  - Параметры: `take`, `skip`, `sort:[{field,dir}]`, `filter:{filters:[{field,operator,value}]}`.
  - Поля: `ticker`, `instr_type`, `instr_kind`, `instr_kind_с`, `code_sec`, `code_rep`, `code_nm`, `name`, `reg_nb`, `issue_nb`, `face_curr_c`, `mkt_id`, `mkt_name`, `mkt_short_code`, `fv`, `step_price`, `x_short`.
  - Операторы: `eq`, `neq`, `eqormore`, `eqorless`, `isempty`, `contains`, `doesnotcontain`, `startswith`, `endswith`, `in`, `isnull`, `notnull`.
  - Ответ: `{securities:[{ticker, instr_type_c, …, quotes:"<JSON-строка>", attributes:"<JSON-строка>", …}], total}`.
  - ⚠️ [MCP]: take только 1..10, «Sort is not exposed (upstream sort is broken)». Пример фильтрует по полю `type`, которого нет в списке полей.
- **`getTopSecurities`** — топ бумаг, публичная [ПРОВЕРЕНО].
  - Параметры: `type` (stocks|bonds|futures|funds|indexes), `exchange` (kazakhstan|europe|usa|ukraine|currencies), `gainers` (1 — быстрорастущие за год, 0 — по объёму), `limit` (default 10).
  - Ответ `{tickers:[…]}`, фактически ещё `details` и `buttons`.
- **`getOptionsByMktNameAndBaseAsset`** — опционы. Параметры `ltr` (рынок) и `base_contract_code`. Ответ `[{ticker, base_contract_code, last_trade_date, expire_date, strike_price, option_type}]`. ⚠️ PHP SDK шлёт `mktName` и `baseAsset`.
- **`checkAllowedTickerAndBanOnTrade`** — разрешён ли тикер к торгам. Параметры `ticker`*, `checkBan`. Ответ `{allowed:0|1, allowedExpires:[1,3,2], restriction?, operation?, recommendations?[]}`. ⚠️ Описание в доке: «Метод позволяет получать данных о опционах» — копипаст.
- **`getStockData`**, **`getShopCatalog`**, **`getReadyList`** — есть в SDK и MCP (plain, без авторизации), в доке разделов нет.

### 5.4. Свечи — `getHloc` (подробно)

V3 POST JSON (в доке единственный раздел, написанный «по-V3») либо GET. Публичная [ПРОВЕРЕНО].

```json
POST https://tradernet.kz/api/getHloc
{"id":"FB.US","count":-1,"timeframe":1440,"date_from":"15.08.2020 00:00","date_to":"16.08.2020 00:00","intervalMode":"ClosedRay"}
```

| Параметр | Тип | Описание |
|---|---|---|
| `id`* | string | Тикер или несколько через запятую: `"FB.US,AAPL.US"` |
| `count` | int | Доп. свечи сверх интервала; отрицательное — до интервала (`-100`). [MCP]: `-1` = только окно, `-N` = N−1 свечей до `date_from` |
| `timeframe`* | int | Минуты: 1, 5, 15, 60, 1440; `-1` — тики/трейды |
| `date_from`, `date_to` | string | **`dd.MM.yyyy HH:mm`** |
| `intervalMode` | string | `ClosedRay` (стандарт); `OpenRay` — расширенный |
| `userId` | int\|null | опц. |
| `hash`, `isTheoreticalData`, `compareIds`, `compareTickets`, `compareStocks` | — | расширенные и legacy |

Ответ:

```json
{"hloc":{"FB.US":[[high,low,open,close],…]},"vl":{"FB.US":[vol,…]},"xSeries":{"FB.US":[unix_sec,…]},
 "maxSeries":{"FB.US":unix_sec},"info":{"FB.US":{id,nt_ticker,short_name,default_ticker,code_nm,currency,min_step,lot}},"took":0.84}
```

- ⚠️ Порядок в свече — **[HIGH, LOW, OPEN, CLOSE]**, не OHLC. Подтверждено реальным ответом: `[339.5,328.76,330.33,338.68]`.
- `ClosedRay` при `timeframe >= 1440` заменяет `date_to` на текущую дату [ДОКА, ПРОВЕРЕНО: вернулось больше свечей, чем просили].
- Tick-режим (`timeframe:-1`): `{"FB.US":{"series":[{"t":"2026-05-25 10:10:01","p":"123.45","q":"10"}],"info":{…}},"took":…}`. Это и есть раздел «Получение трейдов» (`get-trades`).
- Ошибки: `{"error":"Incorrect date"}`, `{"error":"Не найдены инструменты по тикерам: BAD.US"}`, `{"error":"Bad request"}`.
- [ПРОВЕРЕНО 2026-11-01, Task 38] Неизвестный тикер в мульти-запросе валит **весь** запрос: `SP500.IDX,ZZZQX.US` → ошибка с текстом `Failed to find instruments by tickers: ZZZQX.US` (язык текста зависит от кабинета; кода ошибки не видели). Приложение (repo.js `hlocTolerant`) ищет в тексте свои тикеры целыми словами, исключает названные и повторяет запрос; без названных — по одному тикеру последовательно.
- [ПРОВЕРЕНО 2026-10-31, Task 25] `info[ticker]` приходит для каждого тикера, в том числе в мульти-запросе: `{mkt_name, mrkt:{p, o, c, post, dt, tz}}`.
  - `mkt_name`: рынок тикера (`FIX` для US-акций и индексов, `KASE`, `EU`).
  - `mrkt`: часы в серверной зоне. `p` — пре-открытие брокера, `o` — открытие, `c` — конец расширенной сессии, `post` — регулярное закрытие (есть только у `FIX`), `dt` — сервер минус местное время биржи в минутах, `tz` — IANA-зона биржи.
  - Примеры: FIX `p 14:10, o 16:30, post 23:00, c 03:00, dt 420, tz America/New_York` (07:10 / 09:30 / 16:00 / 20:00 по Нью-Йорку, летнее время); KASE `p 09:20, o 09:30, c 20:00, dt −120`, `post` нет; EU `p 10:00, o 11:00, c 21:30, dt 180, tz Europe/London`, `post` нет.
- [ПРОВЕРЕНО, Task 25] Время свечей:
  - сервер в UTC+3 (смещение 10800 с);
  - дневная свеча стоит на полуночи сервера (21:00 UTC предыдущих суток), поэтому смещение сервера = `−ts mod 86400` по дневным свечам (`marketTime.dailyOffset`);
  - ось `xSeries` + смещение сервера = настенное время биржи, и это верно и через перевод часов (SP500.IDX 15m: 09:30–15:45 и в EST, и в EDT; бумаги .EU — 08:00–16:30 по Лондону и в BST, и в GMT);
  - дата бара = UTC-дата (ts + 10800).
- [ПРОВЕРЕНО 2026-10-31] У `NASDAQ.IDX` в дневных свечах бывает бар в субботу после последней сессии (один принт, `vl` = 1). Приложение берёт дневные свечи только до даты последней сессии `SP500.IDX` (`marketTime.dailyThroughSession`).
- [ПРОВЕРЕНО 2026-11-01, Task 42; публичный `getHloc` по двум ETF `.EU` и `SPY.US`] У бумаг `.EU` есть бары на выходных, и это не сессии:
  - 15 мин: в субботу ~18–38 баров примерно с 12:45 до 22:00 по Лондону (в другой уикенд — один бар в 22:00) и бар в воскресенье в 03:00; цена весь день одна, объём ненулевой (десятки–тысячи штук);
  - дневные: бар в субботу и в воскресенье каждую неделю, high = low = open = close, объём 1–2670. Цена этих баров бывает **не равна** закрытию пятницы (в один из уикендов — на ~0.2% выше);
  - у `SPY.US` выходных баров нет;
  - `info[t].mrkt` в воскресенье: `dayoff: "weekend"` и у `EU`, и у `FIX`, плюс `mkt_id`, `st: 1`. `dayoff` описывает только текущий день.
  - Приложение: сессия бывает только в будни (`marketTime.isSessionDay`), окно сессии на выходной пустое (спарклайны Holdings, 1D/5D карточки), дневные свечи карточки рынков без индекса — без выходных.
- ⚠️ PHP SDK шлёт `timeStart` и `timeEnd` вместо `date_from` и `date_to`. Python SDK шлёт `intervalMode:"OpenRay"`. [MCP]: «Only 'ClosedRay' is accepted».

### 5.5. Сделки — `getTradesHistory` (подробно)

Авторизация (SID или HMAC).

| Параметр | Тип | Описание |
|---|---|---|
| `beginDate` | `YYYY-MM-DD` или `YYYY-MM-DDThh:mm:ss` | начало, опц. |
| `endDate` | то же | конец, опц. |
| `tradeId` | int | начиная с этого trade id (курсор) |
| `max` | int | лимит. При `sort=1` по умолчанию 100; при `sort=0` без фильтров — вся история |
| `sort` | int | 0 — по возрастанию trade_id (default), 1 — по убыванию (последние) |
| `nt_ticker` | string | фильтр по тикеру |
| `curr` | string | базовая или котируемая валюта |
| `reception` | int | офис |
| `isServerTime` | bool | даты в серверной TZ (default false — в TZ пользователя) |
| `userId` | int | другой клиент (нужны права) |

Ответ:

```json
{"trades":{"max_trade_id":[{"@text":"40975888"}],"trade":[{"id":…,"order_id":…,"p":141.4,"q":20,"v":2828,"date":"2019-08-15T10:10:22",
 "profit":".00000000","instr_nm":"AAPL.US","curr_c":"USD","type":1,"reception":1,"login":"…","summ":2828,"curr_q":"…","instr_type_c":1,
 "mkt_id":…,"instr_id":…,"comment":"…","step_price":"…","min_step":"…","rate_offer":1,"fv":100,"acd":"…","go_sum":"…",
 "curr_price":"…","pay_d":"2019-08-19T00:00:00","T2_confirm":"…","trade_nb":…,"repo_close":"0","StartCash":"…","EndCash":"…",
 "commiss_exchange":"…","otc":"0","details":"","OrigClOrdID":null}]}}
```

- `type`: 1 — покупка, 2 — продажа.
- ⚠️ [MCP] говорит о `max_trade_id` на верхнем уровне, в доке он внутри `trades`.
- ⚠️ В Python SDK: «If 0 or no parameter is specified — then all trades».

### 5.6. Приказы

- **`getNotifyOrderJson`** — приказы текущего периода. Параметр `active_only` 1|0.
  - Поля приказа: `order_id`, `instr`, `oper` (1 Buy, 2 Buy on Margin, 3 Sell, 4 Sell Short), `type` (1 Market, 2 Limit, 3 Stop, 4 StopLimit, 5 SL, 6 TP), `exp` (1 Day, 2 Day+Ext, 3 GTC), `p`, `q`, `leaves_qty`, `stat` (см. «Статусы приказов»), `stat_d`, `stat_prev`, `stop`, `trailing_price`, `aon`, `cur`, `date`, `user_order_id`, `trade[]{id, p, q, v, date, profit, acd, fv, go_sum}`.
  - ⚠️ Пример — голый массив, таблица — `orders`. [MCP]: `result.orders`; при пустом периоде только `{key}`.
- **`getOrdersHistory`** — история приказов.
  - Параметры: `from`, `till` (ISO `YYYY-MM-DDThh:mm:ss`), `statuses` int[], `tickers` string[], `page:{take 1..1000, skip}`, `order` 0|1, `isServerTime`.
  - Ответ: `{orders:{key, order:[{id, date, stat, instr, oper, type, cur, p, stop, q, leaves_qty, exp, …, trade:[…]}]}}`.
  - ⚠️ Дока: «Без from возвращает последние приказы (лимит 100)». [MCP]: «`from` REQUIRED — upstream returns 400».
- **`putTradeOrder`** (торговая; не вызывалась) — `instr_name`, `action_id` (1, 2, 3, 4), `order_type_id` (1–4), `qty`, `limit_price`, `stop_price`, `expiration_id` (1–3), `user_order_id`. Ответ `{order_id}`.
- **`putStopLoss`** (торговая) — `instr_name`, `take_profit`, `stop_loss`, `stop_loss_percent`, `stoploss_trailing_percent`. Ответ `{order_id, order:{…}}`.
- **`delTradeOrder`** (торговая) — `order_id`. Ответ `{order_id}`.
- **`getTradingLimits`** (V3) — `ticker`*, `price`, `type` (1–4), `with_margin`, `stop`. Ответ `{ticker, max_buy_quantity, max_sell_quantity}`; ошибка `{"error":"Instrument with ticker \"UNKNOWN\" not found","code":400}`. ⚠️ Раздел говорит «Передайте SID… в cookie SID» и тут же V3.

### 5.7. Движение денег — `getUserCashFlows` (подробно)

Раздел «Движение денежных средств» (`get-cashflows`). Авторизация.

| Параметр | Тип | Описание |
|---|---|---|
| `user_id` | int | клиент (опц.) |
| `groupByType` | 0\|1 | группировать по типу |
| `cash_totals` | 0\|1 | суммы по дням |
| `hide_limits` | 0\|1 | скрыть лимиты |
| `take`, `skip` | int | пагинация |
| `without_refund` | 0\|1 | без возвратов |
| `filters` | `[{field, operator, value}]` | поля: `date`, `sum`, `currency`, `comment`, `type_code`. Операторы: `eq`, `neq`, `more`, `eqormore`, `eqorless`, `contains`, `doesnotcontain`, `startswith`, `endswith`, `in` |
| `sort` | `[{field, dir:'ASC'\|'DESC'}]` | ⚠️ [MCP]: на проводе принимается **один объект** `{field,dir}`, массив даёт `400 'field: The parameter is mandatory'` |

Ответ:

```json
{"total":10,
 "cashflow":[{"id":"9f0a11cc61","type_code":"commission_for_trades","icon":"commission","date":"2021-06-28","sum":"-3.00",
              "comment":"(Trade 1515 2021-06-28 12:21:35)","currency":"USD","type_code_name":"…"}],
 "limits":{"USD":{"minimum":50.0,"multiplicity":1.0,"maximum":100.0}},
 "cash_totals":{"currency":"USD","list":[{"date":"2021-06-28","sum":500.62}]}}
```

- ⚠️ В доке `cashflow` записан как `{ {…} }` — невалидный JSON. Скорее всего это массив.
- ⚠️ Описание `eqorless`: «меньше или больше».
- ⚠️ [MCP] называет поля фильтра `summ` и `curr`, дока — `sum` и `currency`.
- Формат дат в фильтре **[НЕ УКАЗАНО]**.
- Справочник `type_code` — раздел «Типы валидных кодов», ~100 кодов: `bank`, `swift`, `cashout`, `card_payout`, `dividend`, `coupon`, `tax`, `commission`, `trade`, `conversion`, `currency_conversion`, `maturity`, `split`, `percents` и т. д.

### 5.8. Отчёты брокера

- **`getBrokerReport`** — отчёт брокера.
  - Параметры: `date_start`, `date_end` (`YYYY-MM-DD`), `time_period` (`23:59:59` или `08:40:00`), `recent` 0|1, `type` (блок), `format` (json|html|xml|xls|pdf, default json), `language`, `account_ids` (1–20 номеров счетов), `currency` (обязателен с `account_ids`).
  - `type`: `account_at_start`, `account_at_end`, `trades`, `commissions`, `corporate_actions`, `in_outs`, `in_outs_securities`, `cash_flows`, `securities_flows`. Генератор ссылок ещё знает `securities_table`, `trades_done_before_period`, `flows`.
  - Ответ: `{report:{plainAccountInfoData, account_at_start, account_at_end, cash_flows_json, cash_flows, securities_flows_json, in_outs_securities, trades, commissions, corporate_actions, …}}`.
  - Ошибка: `{"error":"No param 'time_period'…","code":109}`.
  - ⚠️ Полная структура отчёта отсылает к `docs/project/broker-report-structure.md` и `resources/xsds/...` — внутренним файлам, которых в публичной доке нет.
  - [MCP]: `recent=1` возвращает 400; same-day start=end может быть пустым.
  - Python SDK скачивает отчёт поблочно (по одному `type` на запрос).
- **`getDepositaryReport`** — депозитарный отчёт.
  - Параметры: те же плюс `encoded_result` (файл в base64 в поле `file`).
  - `type`: `all`, `trades_executed_within_period`, `depoData`, `cashFlowsData`, `off_balance_money`, `off_balance_securities`.
  - [MCP]: «UPSTREAM NOT AVAILABLE on tradernet.com (404)».
- **Прямая ссылка** (без подписи):

  ```
  GET https://tradernet.kz/cabinet/ajax-get-billing-report/?format=json&date_start=2026-10-01[&date_end=…][&type=…][&language=en][&is_consolidated=1][&account_ids=[…]&currency=USD][&zip=1]&api_key=<PUBLIC_KEY>&auth_login=<LOGIN>
  GET https://tradernet.kz/cabinet/ajax-get-depositary-billing-report/?…
  ```

  - `date_start` обязателен; `+` в логине кодировать как `%2B`.
  - [ПРОВЕРЕНО]: без ключа `400 {"error":"Ошибка безопасности"}`, с фейковым ключом `403 {"error":"API ключ не найден"}`. Без ACAO на ошибках.
  - ⚠️ Текст требует `auth_login`, а JS-генератор на той же странице подставляет поле `trader_systems_id` («код клиента»).
  - ⚠️ «API ключ» — по [MCP] это **публичный** ключ, то есть отчёт защищён только публичным ключом и логином.
- **`getClientCpsHistory`** — история поручений. Параметры: `cpsDocId`, `id`, `date_from`, `date_to`, `limit`, `offset`, `cps_status` (0 черновик, 1 в процессе, 2 отклонено, 3 исполнено). Ответ `{cps:[…], total}`.
- **`getCpsFiles`** — файлы поручения; **`submitCps`** — подача поручения (в т. ч. вывод денег `type_doc_id=200` в Python SDK). В доке разделов нет.

### 5.9. Рынки — `getMarketStatus` (подробно)

Публичная [ПРОВЕРЕНО]. Параметры: `market` (`*` или briefName: `KASE`, `KASE.CUR`, `AIX`, `FIX`, `EU`, …) и `mode` (`demo` или не указывать).

```json
{"result":{"markets":{"t":"2026-10-31 18:14:29","m":[{"n":"KASE","n2":"KASE","i":"30000000010","s":"CLOSE","o":"09:30:00","c":"20:00:00","dt":"-120"}]}}}
```

| поле | смысл |
|---|---|
| `n`, `n2` | полное и краткое имя |
| `i` | id рынка (есть в живом ответе, нет в доке) |
| `s` | статус: `OPEN`, `CLOSE`, `TECH`, `PREV`, `""` |
| `o`, `c` | открытие и закрытие |
| `dt` | сдвиг «относительно MSK» в минутах |

- ⚠️ Дока говорит «MSK», но для KASE `dt:"-120"`, что соответствует UTC+5 (Алматы) минус 120 мин от MSK.
- ⚠️ [MCP]: `''` = open. В живом ответе встречаются и `OPEN`, и `''`.
- Ошибка: `{"error":"Something wrong, service unavailable","code":14}`.
- В getOPQ у рынка ещё `p`, `post`, `date[]` (праздники), `ev[]` (события).

### 5.10. Валюты

- **`getCrossRatesForDate`** — публичная [ПРОВЕРЕНО]. Параметры: `base_currency`*, `currencies`* (массив), `date` (`YYYY-MM-DD`, опц., иначе сегодня). Ответ `{rates:{KZT:440.86, EUR:0.885…}}`, то есть единиц валюты за 1 базовую.
- Раздел «Список валют» — статическая таблица кодов.

### 5.11. Новости (спайк Task 15, 2026-11-01)

Проверено из браузера с чужого origin (`http://localhost:5173`), form POST `q={cmd,SID,params}` на `tradernet.global`, реальный счёт (viewOnly).

- **Доступ**: через SID работает, CORS проходит **[ПРОВЕРЕНО]**. Анонимно (без SID) любой тикер/язык: HTTP 200 и `{"error":"Invalid CSRF","code":12}` **[НЕ РАБОТАЕТ]**. Вход нужен.
- `getNewsList {ticker, lang, take, skip}` **[ПРОВЕРЕНО]** → `{list:[{id, title, provider, providerAlias, lang, date, url, sentiment (строка), tickers[], images[]}], total, take, skip}`. Тикер в формате `AAPL.US`. Сортировка: новые первыми. `take:10` — ~3.8 КБ, ~0.8 с. `date` — строка `YYYY-MM-DD HH:MM:SS` без зоны (в detail зона `+0300`). `url` бывает пустым/относительным или внешним (например, `finance.yahoo.com`). `images[]` — хост `tradernet.global` (при `img-src 'self' data:` блокируются, не показывать). Параметр `provider` не проверялся.
- `getNewsDetail {id}` **[ПРОВЕРЕНО]** → `{id, title, text, provider, providerAlias, lang, dateTime, timeZone:"+0300", url, sentiment, tickers, images}`. ~7 КБ, ~0.24 с. `text` — полный текст, не тизер (HTML 4–11 тыс. знаков). Теги в выборке: `a, b, h2, i, p`; атрибуты `href, target`; `img/script/iframe/style/object/form` не встречались; относительных ссылок нет; ссылки ведут на `tap.tradernet.global`. Для KZ-новости текст без тегов (plain text).
- **Языки** **[ПРОВЕРЕНО]**: `en` и `ru`. US-тикеры: AAPL.US en 3711 / ru 4186, SPY.US en 40 / ru 31 (разные наборы, не переводы). KZTO.KZ: en `total=0`, ru `total=3` (2024 год). Провайдеры: `Oninvest`, `OninvestCompanyNews`.
- **Свежесть**: AAPL — новейшая 2026-10-31 11:01 (выходные), 10 штук за ~2 суток; SPY — новейшая 2026-10-19 (за ~13 дней до проверки), 40 за ~3 недели; KZTO — старые (2024).
- `sentiment`: тип строка; набор значений **не проверен**.
- Не проверено: `getNewsProvidersList`, `getCombinedNews`, пагинация дальше `skip=0`, лимиты частоты, ошибки 400 `Validation failed` / 404 `Новость не найдена` (взяты из документации), фильтр `provider`.

### 5.12. Списки бумаг (watchlists) и алерты

- `getUserStockLists` → `{userStockLists:[{id, userId, name, tickers[], picture}], selectedId, defaultId}`.
- `addStockList {name, picture, tickers[]}`.
- `updateStockList {id, name, picture, index}`.
- `deleteStockList {id}`.
- `makeStockListSelected {id}`.
- `addStockListTicker {id, ticker, index}`.
- `deleteStockListTicker {id, ticker}`.

Все возвращают обновлённый `userStockLists`. ⚠️ JS-примеры используют `$.getJSON` (GET), хотя в заголовке раздела «HTTPS POST».

Алерты:

- `getAlertsList {ticker?}` → `{alerts:[{id, ticker, init_price, trigger_price:"<JSON-строка>", quote_type, notification_type, trigger_type, periodic, expire, triggered, deleted}]}`.
- `togglePriceAlert` (старое имя `addPriceAlert`):
  - добавление `{ticker, price:{price:"500"}, trigger_type, quote_type, notification_type, alert_period, expire}`;
  - удаление `{id, del:true, quote_type, notification_type}`.
- Справочники:
  - `quote_type`: ltp, bap, bbp, op, pp;
  - `notification_type`: email, sms, push, all;
  - `trigger_type`: crossing, crossing_down, crossing_up, less_then, greater_then, channel_*, moving_*;
  - `alert_period`: 0, 60, 300, 900, 3600, 86400;
  - `expire`: 0, end_of_day, till_time.

### 5.13. Прочие справочники (статические таблицы, не команды)

- «Торговые площадки» (`mkt`): ID, код, короткий код. Пример: KASE = 30000000010, AIX = 30000000025, FIX = 30000000001.
- «Данные об инструментах»: `instr_type_c`/`instr_kind_c`.
- «Статусы приказов»: 0, 1, 2, 10, 11, 12, 20, 21, 30, 31, 70, 71, 72, 74, 75.
- «Типы подписей» (`safety_type_id`): 14 = «Ключ API».
- «Список типов поручений» (`cpsDocId`).
- «Типы документов для анкеты».
- «Список действующих офисов» (reception ID). ⚠️ Казахстанского офиса Freedom Finance в списке нет, есть только `KZ_CALLCENTER (61)`.
- «Типы валидных кодов».
- «Список валют».

---

## 6. WebSocket

### 6.1. Адрес и авторизация

- [ДОКА] «Адрес сервера wss.trade.almaty-ffin.global». ⚠️ Имя не резолвится. Рабочие: **`wss://wss.tradernet.kz/`**, `wss://wss.almaty-ffin.global/`, `wss://wss.tradernet.com/`, `wss://wss.freedom24.com/` [ПРОВЕРЕНО].
- [ДОКА] Авторизация по SID GET-параметром: `new WebSocket('wss://wss.…/?SID=<your-sid>')`. Без SID приходят демо-данные в котировках и стакане, подписки на приказы и сессии недоступны.
- ⚠️ [SDK-PY] подключается с query `?X-NtApi-PublicKey=<pub>&X-NtApi-Timestamp=<ts>&X-NtApi-Sig=HMAC(secret, ts)` (функция `Core.websocket_auth()`). [SDK-PHP `docs/websocket.md`]: «Authentication is **SID only** — API keys are not used on the socket». Работает ли ключ через query, проверить без ключей нельзя: с фейковыми ключами сервер принимает рукопожатие и отдаёт `mode:"demo"`.
- [SDK-PHP]: «Cloudflare fronts wss.{domain} and rejects well-known HTTP library agents» (handshake → 403). Браузерный UA проходит.

### 6.2. Origin и CORS для WS [ПРОВЕРЕНО]

На WS не действует CORS, но сервер (или Cloudflare) проверяет `Origin`.

| Origin | URL | Результат |
|---|---|---|
| `https://example.com` | `wss://wss.tradernet.kz/` | **403** |
| `https://example.com` | `…/?x=1` | **403** |
| `https://example.com` | `…/?SID=invalid` | 101, `userData` mode demo |
| `https://example.com` | `…/?X-NtApi-PublicKey=test&X-NtApi-Timestamp=…&X-NtApi-Sig=00` | 101, demo |
| `http://localhost:8080` | `…/?SID=invalid` | 101 |
| `http://localhost:8080` | `…/` | 403 |
| `https://tradernet.kz` | `…/?x=1` | 101 |
| без Origin | `…/?x=1` | 101 |

Результаты стабильны при повторе. Чужой Origin пускают только при наличии в URL параметров авторизации (`SID` или `X-NtApi-*`). Для нашего SPA подключение с SID или ключами в query **возможно** из браузера; анонимный демо-WS с чужого Origin — нет.

### 6.3. Формат сообщений

- [ДОКА] `[event, data]`.
- [ПРОВЕРЕНО] Фактически приходит третий элемент: `["q", {…}, "wstm=2026-10-31T15%3A20%3A04.896Z"]`. Python SDK распаковывает именно `event, data, _`.

Первое сообщение после подключения [ПРОВЕРЕНО]:

```json
["userData",{"mode":"demo","connections":{"quotes":"ntdemo-msk","delayedQuotes":"ntdemo-msk","orderBook":"tsexec",…},"version":"4.4.0.prod"},"wstm=…"]
```

⚠️ Дока описывает `userData` с полями `isDemo`, `mode`, `authLogin`, `login`, `clientLogin`; в таблице ошибочно `model`.

### 6.4. Подписки

| Отправить | Событие | Данные | Нужен SID |
|---|---|---|---|
| `["quotes", ["AAPL.US","KSPI.KZ"]]` | `q` | Первым приходит полный снимок котировки (поля как у getStockQuotesJson плюс `chg5/22/110/220`, `p5/22/110/220`, `x_curr`, `x_currVal`, `marketStatus`, `scheme_calc`…), далее дельты только изменившихся полей с `c` и `n` | нет (без SID — демо) |
| `["orderBook", ["AAPL.US"]]` | `b` | `{n, i, cnt, ins[], del[], upd[], min_step, step_price, x}`; строка `{p, s:'S'\|'B', q, k}`. `n=0` — полный снимок, затем +1. Применять del → ins → upd по позиции `k`. Каждый запрос **заменяет** список; отписка — `["orderBook", []]` | нет (демо) |
| `["portfolio"]` | `portfolio` | `{key, acc[], pos[]}` (как getPositionJson) | да. Без SID: `["error",{"error":"Access to portfolio subscription denied","subscription":"portfolio","code":"unauthenticated"}]` |
| `["orders"]` | `orders` | массив приказов (как getNotifyOrderJson) | да |
| `["sessions"]` | `sessions` | массив сессий безопасности | да |
| `["markets"]` | `markets` | `{t, m:[{n,n2,s,o,c,dt}]}` | по доке нет. ⚠️ В демо за 10 с ничего не пришло; вероятно, шлёт только при изменениях |

- ⚠️ В примере раздела `websocket-sessions` отправляется `['session']` (ед. ч.), а событие и проверенное имя подписки — `sessions`.
- ⚠️ В разделе `quotes-get-changes` в примере `ws.send("quotes", JSON.stringify(['quotes', …]))`. Это баг: уйдёт строка `"quotes"`.
- Переподключение не встроено; дока рекомендует реконнект с задержкой 5 с.
- Заменяет ли повторный `quotes` предыдущий список — **[НЕ УКАЗАНО]** (для orderBook — да).
- Демо-котировки отличаются от реальных: WS-демо AAPL 344.4 при реальном `/securities/export` 345.13 в одно время.

---

## 7. Противоречия и пробелы документации

1. **Смесь трёх версий API.** Почти все разделы написаны в формате V1 (`{"cmd","SID","params"}`, `$.getJSON(".../api/", {q: …})`), с пометками «HTTPS POST (Для API V2)». Текущая авторизация — V3 (заголовки). Как V1/V2-описание маппится на V3, явно не сказано. Фактически: тело V3 = содержимое `params`, `cmd` — в URL.
2. **Подпись V1/V2 не описана.** Ссылки на «Ключ API, параграф 4» ведут на переписанную под V3 страницу. Python-примеры используют несуществующий `PublicApiClient().V1/V2`. Разделы `/tradernet-api/public-api-client` и `/tradernet-api/python-sdk` пустые.
3. **Окно timestamp, replay, поведение при неверной подписи и просроченном ts** — не указано.
4. **Домены.** «Любая доменная зона» в доке против «ключ привязан к домену» в PHP SDK. KZ-дока указывает несуществующий WS-хост `wss.trade.almaty-ffin.global`.
5. **WS-авторизация ключами**: Python SDK (query `X-NtApi-*`) против PHP SDK («SID only»). Дока описывает только SID.
6. **CORS** не описан вообще. Примеры «для браузера» с `withCredentials` не могут работать без `Access-Control-Allow-Credentials`, которого сервер не отдаёт.
7. **Лимиты**: указан только `getAllSecurities` — 10/мин.
8. **Таблицы кодов ошибок нет.** Ключи ошибок разнятся: `error`, `errMsg`, `errorMsg`.
9. **Ответы с невалидным или противоречивым JSON и обёртками:**
   - `getPositionJson`: `{key,acc,pos}` против `result` против `ps`;
   - `getNotifyOrderJson`: массив против `orders`;
   - `getUserCashFlows`: `cashflow: { {…} }`;
   - `getOPQ`: `"instr_id": ,`.
10. **Копипаст в описаниях:** `getSecurityInfo` («свечи»), `checkAllowedTicker…` («опционы»), `bac` = описание `ltc`, `dpd`/`dpb`, `eqorless` «меньше или больше», `userData.model`.
11. **Имена параметров расходятся между докой и SDK:**
    - `getHloc` `date_from`/`date_to` против `timeStart`/`timeEnd` (PHP SDK);
    - `intervalMode` OpenRay (Python SDK) против «only ClosedRay» (MCP);
    - `getOptionsByMktNameAndBaseAsset` `ltr`/`base_contract_code` против `mktName`/`baseAsset`;
    - `getAuthSms` `tel` против `phone`;
    - `getStockQuotesJson.tickers` — массив или строка;
    - `getUserCashFlows.sort` — массив по доке, объект по MCP;
    - поля фильтра `sum`/`currency` против `summ`/`curr`.
12. **Обязательность:** `getOrdersHistory.from` по доке опционален, по MCP обязателен (400). `getBrokerReport.recent` по доке есть, по MCP даёт 400.
13. **Прямые ссылки на отчёт:** текст требует `auth_login`, генератор на той же странице — `trader_systems_id`.
14. **Отсутствуют разделы для команд, которые есть в SDK и MCP:** `getAuthInfo` (только упоминание), `GetAllUserTexInfo`, `GetAllAnketInfo`, `getConnectedUsersAssets`, `switchToConnectedUser`, `getStockData`, `getShopCatalog`, `getReadyList`, `getCpsFiles`, `submitCps`, `GetListTariffs`, `SelectTariff`, `getPlannedCorpActions`, `getTradeVolumesCounter`, `getTradesStatistics`, `getCombinedNews`, `uploadFiles`, `/refbooks/…`.
15. **Описание структуры брокерского отчёта** ссылается на внутренние файлы (`docs/project/broker-report-structure.md`, XSD), которые не опубликованы.
16. Форматы дат различаются по командам и местами не описаны:
    - `getHloc` — `dd.MM.yyyy HH:mm`;
    - `getTradesHistory`, `getOrdersHistory` — ISO;
    - отчёты — `YYYY-MM-DD`;
    - `getSecurityInfo.firstDate` — `MM.DD.YYYY`;
    - формат дат в фильтрах cashflows — не указан.

---

## 8. Данные о бумаге для карточки (спайк Task 22, 2026-10-31)

Проверено анонимным form POST `q=` на `tradernet.global` с `Origin: https://portfolio.zigmund.xyz`: все ответы 200 с `access-control-allow-origin`, то есть читаются из браузера без SID. Тикеры: AAPL.US, MSFT.US, SPY.US, QQQ.US, KZTO.KZ, KSPI.KZ. WS-поля и SID-варианты не проверялись (нужен вход владельца).

### 8.1. `getSecurityInfo {ticker, sup:false}` — одна бумага, 150 полей, плоский объект (без обёртки `result`)
Числа — настоящие числа. Живое состояние на момент запроса, обновляется с биржей.

| Что нужно | Поле | Заметки |
|---|---|---|
| последняя цена, время | `ltp`, `ltt` | `ltt` без TZ |
| предыдущее закрытие | `pp` (приложение берёт его как Previous close) | AAPL.US, выходные 2026-10-31: `chg = ltp − pp` ровно (345.13 − 348.91 = −3.78), тогда как `ClosePrice` держал официальное закрытие пятницы. Семантика `pp`/`ClosePrice` во время живой US-сессии не проверена |
| изменение за день | `chg` (абс.), `pcp` (%) | считаются от `pp` (см. выше), не от `ClosePrice` |
| диапазон дня | `mintp`, `maxtp` | |
| объём дня | `vol` (шт., включая пре/пост), `vlt` (сумма) | |
| bid/ask | `bbp`, `bap` | на закрытом рынке может быть 0 |
| доходность периодов | `chg1w/1m/6m/1y` (%), цены `p1w/p1m/p6m/p1y` | |
| волатильность | `volatility7/30/90/180/365` (%) | это не beta |
| прогнозные квантили | `target{7,30,90,180,365}_p{0.05..0.95}` | вероятностные коридоры в % к цене, не цели аналитиков |
| тип | `kind`: 1 акция, 7 ETF/фонд | `type` всегда 1 |
| валюта, рынок | `x_curr`, `ltr` (FIX/KASE), `codesub_nm` (NASDAQ/ARCA/KASE) | |
| статус | `marketStatus` (`TECH`, `CLOSE`, …) | |
| ISIN, описание | `issue_nb`, `x_descr` (русский текст) | |

Ненадёжные поля: `op` (AAPL 140.98, SPY 393.1 — не дневное открытие; открытие брать из дневной свечи `getHloc`), `x_min`/`x_max` (у US-бумаг похожи на 52-недельный диапазон (AAPL 246.85/352.06 против 245.72/352.6 по свечам), у KZTO явно мусор 797/898.95 при цене 1386; считать 52w из `getHloc`), `mtd`, `ncd`.
Нет: P/E, beta, market cap, дивидендная доходность, EPS, NAV, чистые активы, пре/пост-цена.

`sup:true` — 11 полей (`id, short_name, currency, lot, mkt_name, firstDate` и `mrkt`). `mrkt` для US: `{p:"14:10:00" (пре-маркет с), o:"16:30:00" (open), c:"03:00:00", post:"23:00:00", dayoff, tz:"America/New_York", dt:420}`. Часы в серверной зоне, зависят от перевода часов (DST), использовать только справочно.

### 8.2. `getStockData {ticker}` — «витрина» (shop), ~90 полей, ответ плоский
Анонимно доступен, но данные витрины **устаревшие и точечные**: `market_cap` AAPL 2.46T (реально >5T), `investbank_recommendations` датированы 2023 (Goldman, Morgan Stanley… `{date,name,target,recommendation}`), `revenue`/`gross_profit` не соответствуют TTM, `dividend_income` строкой `"0,57%"`, `points[]`, `potential` (число-цель). Для KZTO/QQQ эти поля пустые, для KSPI.KZ `null`. Есть `attributes` (CUSIP, LEI, `CFICode`, `appropriateness_type: etf_regular`, `tradestart_date_EU`), `quotes` (строки, в том числе `limit_up/limit_down`, `volume_q`), `nrd_data` (справочник НРД: эмитент, управляющая компания и сайт фонда, размещённый объём), `text` (HTML, v-html запрещён), `logo` (путь на tradernet).
Вывод: не годится как источник Key statistics и Analysis (stale, пустые для KZ и ETF). Можно брать: `nrd_data.issuer.name_full_en`, `issuesize` (число акций, для оценки капитализации умножением на `ltp`, при условии актуальности), `x_descr`/`text` как описание (только текстом).

### 8.3. `getHloc` — свечи (CORS ок)
- `timeframe:1440`, `count:-400`, `date_from:"01.01.2026 00:00"`, `date_to:"31.10.2026 00:00"` вернул 609 дневных свечей (с 2024-05, то есть `count` не ограничивает окно жёстко). Свеча `[high, low, open, close]`, `vl` — объём шт., `xSeries` — unix сек (дневная свеча = 21:00 UTC предыдущих суток).
- 52-недельный диапазон: max high / min low по последним ~252 свечам (AAPL 352.6 / 245.72). Средний объём: среднее `vl` по последним 63 свечам (AAPL ~19.6M, но свеча последнего дня включает пре/пост).
- Дневное открытие: `[2]` последней дневной свечи.
- `timeframe:5` за сутки: 192 свечи, покрывают пре-маркет, основную сессию и пост-маркет (сумма объёмов 68.95M = `quotes.volume_q`). Объём пре/пост-баров мал (единицы тысяч за 5 минут). Ось `xSeries` — настенное время биржи минус смещение сервера (UTC+3): 04:00–20:00 по Нью-Йорку выглядит как 01:00–16:55 UTC. Проверено в Task 25, см. §5.4.

### 8.4. `GET /securities/export?tickers=A+B&params=f1+f2` (CORS ок)
Отдаёт только поля из `getSecurityInfo` (проверено `c ltp pp x_min x_max vol name kind type x_descr`). Несуществующие поля (`market_cap`, `trailing_pe`, `beta`, `eps`, `dividend_yield`) молча отбрасываются. Фундаментала нет.

### 8.5. Что отсутствует
- Команды `getCorpActions, getDividends, getNews, getAnalytics, getFinancials, getEarnings, getFundamentals, getRecommendations, getIdeas, getFundComposition, getEtfHoldings` — `Command not found` (code 5). Отчётности, EPS, прогнозов, состава ETF нет.
- `getReadyList` — `Command not found` анонимно.
- `getNewsList` анонимно: `Invalid CSRF` (code 12), нужен SID, см. §5.11.
- `getPlannedCorpActions {reception:35}` анонимно работает, но отдаёт **весь корпоративный календарь одним ответом: 254 474 записи, ~150 МБ, 504 по таймауту при повторных вызовах**. Фильтры `ticker`, `tickers`, `date_from/to`, `from/till`, `take` не сработали (ответ пустой по таймауту или `Incorrect request parameters`). Запись: `{type: dividend|split|coupon|maturity|stock_dividend|spin_off|…, ticker, ex_date, pay_date, currency, amount_per_one (строка), …}`. Для браузера непригодно. Повторно не вызывать без идеи фильтра.

### 8.6. SID против анонимного доступа и поля WS `quotes` (Task 22/15, 2026-11-01)
- `getSecurityInfo` с SID **идентичен** анонимному: AAPL.US и SPY.US по 150 полей, различий нет. Полей пре/пост-цены нет.
- WS (`mode=prod`) подписка `quotes` на AAPL.US/SPY.US/QQQ.US за 20 с в воскресенье: 1 `userData`, по 3 сообщения `q`. Имена полей: `c ltp ltt lts ltr bbp bbs bbt bap bas bat bbf baf op pp pcp chg ClosePrice TradingReferencePrice mintp maxtp vol vlt marketStatus TradingSessionSubID(строка) chg1w/1m/6m/1y/5/22/110/220 p1w/p1m/p6m/p1y volatility{7..365} target{7..365}_p{0.05..0.95} x_curr x_descr x_lot x_min x_max x_min_lot_q x_istrade kind type name name2 codesub_nm issue_nb UTCOffset acc_srv_tm` и др. (опционные `delta gamma theta vega rho iv strike_price`, облигационные `yld*`, служебные `*_source`). Сравнение с полями `getSecurityInfo` не делалось.
- Значения `marketStatus` / `TradingSessionSubID` в пре/пост-сессии **не проверены** (выходной), нужна US-сессия.
