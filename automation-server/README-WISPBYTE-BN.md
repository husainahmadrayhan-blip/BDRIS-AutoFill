# Wispbyte-এ আলাদা Puppeteer Automation Service

Automation Server deployment guide; Main app configuration আলাদা থাকে।

## বর্তমান অবস্থা ও সীমা

`automation-server/` একটি পৃথক Node.js process/service: নিজস্ব Express entry point, port, shared-secret authentication, সীমিত job queue এবং Puppeteer-managed Chromium ব্যবহার করে। Main app-এ authenticated `/api/automation/jobs` gateway যোগ হয়েছে; gateway-এর secret browser-এ পাঠানো হয় না।

**গুরুত্বপূর্ণ সামঞ্জস্য সীমা:** বর্তমান Main app-এর পুরোনো `/api/generate-pdf`, `/api/init-search` এবং `/api/submit-captcha` route এখনও `index.js`-এর Puppeteer code ব্যবহার করে। এই legacy route-গুলোকে এই job service-এ স্থানান্তর করা হয়নি, কারণ eVerify CAPTCHA flow একাধিক HTTP request জুড়ে live browser page/session ধরে রাখে। অতএব ওই তিনটি route চললে Main process-এও Chromium চালু হবে। নতুন service-কে deploy করা মানেই পুরোনো browser কাজগুলো আলাদা হয়ে গেছে—এমন নয়। Main process-এ Puppeteer সম্পূর্ণ বন্ধ করতে হলে এই stateful legacy flow-সহ route-গুলো আলাদা migration/test করতে হবে।

Service শুধু `navigate` ও `fill-form` job গ্রহণ করে। Form field পূরণ করে validation দেখে, কিন্তু কখনো submit করে না; password field প্রত্যাখ্যান করে। CAPTCHA/OTP/security verification শনাক্ত হলে job `human_verification_required` status-এ থামে, কিছু bypass করে না। Arbitrary JavaScript, shell command কিংবা সরকারি সাইটে আবেদন submit করার task নেই।

## Wispbyte compatibility যাচাই

Wispbyte-এর public landing page-এ free 24/7 hosting এবং websites, Discord bots ও applications হোস্ট করার বর্ণনা পাওয়া যায়। Wispbyte-এর [Node.js guide](https://wispbyte.com/kb/typescript-nodejs) Node.js image ও `JS_FILE` startup variable বর্ণনা করে; কিন্তু উপলব্ধ নথিতে নির্দিষ্ট Node version তালিকা নেই। [Startup Settings](https://wispbyte.com/kb/startup-settings) startup command ও environment field সম্পাদনার কথা বলে। [Static web server guide](https://wispbyte.com/kb/static-web-server) `PORT` server info-তে খুঁজে code-এ ব্যবহারের নির্দেশ দেয়; Wispbyte স্বয়ংক্রিয়ভাবে `PORT` environment-এ inject করে—এমন নিশ্চয়তা নেই।

Wispbyte-এর [Server Management guide](https://wispbyte.com/kb/server-management) Free tier-এ প্রতি server-এ 512 MB RAM default বলে; Discord hosting-এর paid tiers-এ ভিন্ন resource listing আছে, যা অন্য product/plan-এর specification নয়। Public docs-এ নির্দিষ্ট account/plan-এর OS, CPU quota, browser binary ও shared libraries, sandbox flags, writable/persistent disk, restart policy, একই account-এ দ্বিতীয় Node service/background worker অনুমোদন, বা দীর্ঘস্থায়ী process-এর সীমা নিশ্চিত করা যায়নি। Browser support ও account resource স্থানীয় test দিয়ে প্রমাণ করা সম্ভব নয়।

Deploy করার আগে Wispbyte panel/support-এ নিশ্চিত করুন:

1. Node.js `>=22.12.0` image/runtime নির্বাচন করা যায় কি না (`package.json`-এর `engines`); public docs version matrix দেয় না।
2. আলাদা দ্বিতীয় Node.js service/process এবং browser child-process চালানো অনুমোদিত কি না।
3. Chromium-এর OS shared libraries ও `--no-sandbox` mode সমর্থিত কি না। Managed Puppeteer Chromium চালু না হলে panel-এ থাকা Chrome/Chromium path `PUPPETEER_EXECUTABLE_PATH`-এ দিন।
4. App-এর assigned port server info থেকে নিন এবং panel-এর Startup Settings-এ environment var configure করুন। Public docs `PORT` automatic injection নিশ্চিত করে না। Automation process `AUTOMATION_PORT` থাকলে সেটি, অন্যথায় hosting-এ manually configure করা `PORT`, শেষে local default `3001` ব্যবহার করে।
5. Restart-এর পর writable data directory থাকে কি না। Wispbyte public docs filesystem durability guarantee দেয় না; metadata-র জন্য `AUTOMATION_JOB_STORE`-কে persistent/private path দিন। Storage না থাকলে restart-এর পর পুরোনো job history থাকবে না। Backup availability product/plan অনুযায়ী ভিন্ন হতে পারে।
6. Plan-এর CPU/RAM ও execution/process timeout অনুযায়ী concurrency `1` রাখুন এবং job timeout কম রাখুন।

`worker.js` queue worker-কে Automation Server-এর একই Node.js process-এ চালায়; আলাদা worker child-process প্রয়োজন নেই। Main Web Server এবং Automation Server কিন্তু দুইটি আলাদা hosting service/process। Browser launch preflight process start-এর সময় Chrome খুলে পরীক্ষা করে, তারপর browser বন্ধ করে; ব্যর্থ হলে সুনির্দিষ্ট error log হয় এবং `/health`-এর `browserReady` false দেখায়। Job চালাতে গিয়ে browser আবার আলাদাভাবে launch হয়। Error-এ log-এর প্রথম কারণ দেখুন; অনুমান করে Wispbyte-এ Chromium কাজ করে বলে ধরে নেবেন না। Hosting account যদি দ্বিতীয় Node service-ই অনুমোদন না করে, Automation Server-কে অন্য বৈধ hosting service-এ deploy করুন; Main app-এর সঙ্গে process মেশাবেন না।

## আলাদা deployment

দুটি service-কে আলাদা Wispbyte Node app/service হিসেবে deploy করুন; প্রতিটি service-এ সংশ্লিষ্ট folder-এর `package.json` এবং নিজস্ব startup command ব্যবহার করুন:

- Main Web Server: repository root, `npm install`, `npm start` (`node server.js`)।
- Puppeteer Automation Server: `automation-server/`, `npm install`, `npm start` (`node server.js`)।

Wispbyte-এ দ্বিতীয় server তৈরি করতে `bdris-automation-server` নাম দিন, Node.js server type/runtime নির্বাচন করুন, তারপর File Manager/Git deployment-এ শুধু `automation-server/`-এর code ও package files দিন। Startup Settings-এ working directory `automation-server/`, startup command `npm start` দিন (অথবা `node server.js`)। Startup Settings-এ environment fields যোগ করুন। Wispbyte Node guide-এ `JS_FILE`-এর default `index.js` বলা আছে; UI যদি সরাসরি startup file চায়, `server.js` সেট করুন। Wispbyte package installation-এ `npm install` চালালে browser download/postinstall অনুমোদিত হয় কি না Console log-এ যাচাই করুন।

Main app ও Automation Server পৃথক server/service এবং পৃথক process হিসেবে চালান। `PORT` hosting কর্তৃক সরবরাহ/নির্ধারণ করা হলে সেটিই ব্যবহার হবে; panel-এ assigned port `PORT`-এ manually দিতে হবে কি না startup settings-এ যাচাই করুন. Background `node` process হাতে spawn করবেন না; দ্বিতীয় service-কে panel-এর নিজস্ব process manager দিয়ে চালান। Restart policy panel-এ enable করুন; policy/port/process allowance plan-এ আছে কি না account-specific ভাবে যাচাই করুন।

Free plan-এর public guide-এ 512 MB RAM default উল্লেখ আছে—এই কারণে concurrency `1` রাখুন, screenshot/PDF-heavy task queue করবেন না, timeout সীমিত রাখুন এবং memory চাপ থাকলে browser task না চালিয়ে বেশি RAM-এর plan/host ব্যবহার করুন। Chromium download/install system package বা shared-library অনুপস্থিতির error দিলে Wispbyte Console-এ `npx puppeteer browsers install chrome` চালানোর অনুমতি এবং disk persistence support যাচাই করুন। System Chrome থাকলে তার absolute path `PUPPETEER_EXECUTABLE_PATH`-এ দিন। System package (apt) install/root privilege docs-এ নিশ্চিত নয়; অনুমতি নেই হলে apt install command দিয়ে সমাধান ধরে নেবেন না—Wispbyte support-এর অনুমতি বা Chromium dependencies সহ অন্য approved host/container ব্যবহার করুন।

### Automation Server-এর environment

`automation-server/.env.example` হলো উদাহরণ; production-এ hosting panel-এর secret/environment settings-এ মান দিন:

| Variable | প্রয়োজন | বর্ণনা |
|---|---:|---|
| `AUTOMATION_API_KEY` | হ্যাঁ | দুই service-এর shared secret; অন্তত 32 random characters |
| `AUTOMATION_ALLOWED_HOSTS` | হ্যাঁ | comma-separated অনুমোদিত public DNS hostname; যেমন `example.com` |
| `AUTOMATION_PORT` বা `PORT` | Hosting-নির্ভর | Automation listener port |
| `AUTOMATION_CONCURRENCY` | না | `1` default; সর্বোচ্চ `4` |
| `AUTOMATION_JOB_TIMEOUT_MS` | না | `60000` default; 180000 ms সর্বোচ্চ |
| `AUTOMATION_NAVIGATION_TIMEOUT_MS` | না | `30000` default |
| `AUTOMATION_SELECTOR_TIMEOUT_MS` | না | `10000` default |
| `AUTOMATION_RETRY_LIMIT` | না | `0` default; সর্বোচ্চ `3` |
| `PUPPETEER_EXECUTABLE_PATH` | না | system Chrome/Chromium path; unset হলে Puppeteer-managed browser |
| `AUTOMATION_JOB_STORE` | না | job metadata file path; default project-এর `.private/automation-jobs.json` |

API key-এর উদাহরণ generate করতে local terminal-এ `node -e "console.log(require('node:crypto').randomBytes(32).toString('hex'))"` চালান; তৈরি হওয়া মানটি শুধু দুই hosting service-এর secret/environment panel-এ বসান, source বা chat-এ নয়।

### Main Web Server-এর environment

Main service-এ `AUTOMATION_SERVER_URL` হবে Automation app-এর private/internal HTTPS URL এবং `AUTOMATION_API_KEY`-এ একই shared secret থাকবে। Main app-এর `DATABASE_URL`, `AUTH_SECRET`, Admin/User credential বা Neon setting পরিবর্তনের প্রয়োজন নেই। Key কখনো HTML/Frontend-এ দেবেন না।

`.env`, `.env.local`, `automation-server/.env`, browser profile/cache ও job data commit করবেন না। `.gitignore`-এ `.env`, `.private/`, `.cache/`, `node_modules/` ignore করা আছে।

## Local development

প্রথমে root এবং Automation dependency install করুন:

```powershell
npm install
Push-Location automation-server
npm install
Pop-Location
```

দুটি PowerShell terminal-এ চালান। `.env.local` বা shell environment-এ Main app settings রাখুন। Automation app-এর জন্য `automation-server/.env` তৈরি করে `.env.example`-এর মান দিন; API key দুই service-এ একই হতে হবে।

```powershell
npm start
```

```powershell
Push-Location automation-server
npm start
Pop-Location
```

Automation host allowlist-এ কেবল কাজের প্রয়োজনীয় public HTTPS hostname দিন। Local test-এর default allowlist `example.com`; production-এ সেটিকে প্রয়োজনীয় host দিয়ে প্রতিস্থাপন করুন।

## API

সব automation endpoint-এ `Authorization: Bearer <AUTOMATION_API_KEY>` আবশ্যক; `GET /health`-ও public নয়। Rate limit প্রতি key-তে প্রতি মিনিটে 30 request। Job owner isolation Main gateway-র authenticated user id ব্যবহার করে।

- `GET /health`
- `POST /api/jobs`
- `GET /api/jobs/:id`
- `POST /api/jobs/:id/cancel`

শুধু অনুমোদিত host-এর HTTPS URL, `navigate` বা `fill-form` type গ্রহণ করে। localhost, private/reserved IP, query/hash/URL credentials ও অননুমোদিত host ব্লক হয়। Redirect এবং page subresource-ও একই host/IP check পাস করতে হয়। Job idempotency-এর জন্য `Idempotency-Key` দিন।

Navigation উদাহরণ:

```json
{"type":"navigate","url":"https://example.com","waitUntil":"domcontentloaded"}
```

Form fill উদাহরণ—কোনো submit হয় না:

```json
{"type":"fill-form","url":"https://example.com","fields":[{"selector":"#name","value":"Sample"}]}
```

Main app থেকে authenticated user route `/api/automation/jobs`, `/api/automation/jobs/:id`, `/api/automation/jobs/:id/cancel` ব্যবহার করতে পারে। Main Web Server automation service-কে server-side থেকে call করে; secret client-এ প্রকাশিত হয় না।

Queue status metadata এবং sanitized logs `.private/`-এ persist হয়; job payload সেখানে সংরক্ষণ করা হয় না। Restart-এর সময় আগে থেকে queued/running job-কে `failed` হিসেবে mark করা হয়, স্বয়ংক্রিয়ভাবে replay করা হয় না—তাই duplicate side effect এড়ানো হয়। Job result-এ form input রাখা হয় না।

## যাচাই

```powershell
npm run build
npm test
Push-Location automation-server
npm test
Pop-Location
node scripts/health-check.js
```

Automation suite authentication, URL policy, queue/idempotency, restart state, timeout এবং local machine-এ বাস্তব Chromium launch + `https://example.com` navigation পরীক্ষা করে। Public network বা local Chromium unavailable হলে browser integration test ব্যর্থ হবে; তা hosting support-এর প্রমাণ নয়। Wispbyte deployment পরীক্ষা আলাদা করে production service URL-এ `scripts/health-check.js` চালিয়ে করুন।
