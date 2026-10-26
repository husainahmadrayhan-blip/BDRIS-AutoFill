# Neon PostgreSQL সেটআপ (FIL New Admin)

## ১. `.env` তৈরি করুন

এই ফোল্ডারের `.env.example` কপি করে একই ফোল্ডারে `.env` নামে রাখুন। `DATABASE_URL`, `AUTH_SECRET`, `ADMIN_USERNAME`, `ADMIN_PASSWORD`-এর মান নিজের মতো বসান। `.env` GitHub-এ আপলোড করবেন না।

Neon Dashboard → Project → Connect থেকে **pooled connection string** কপি করুন। `DATABASE_URL`-এ পুরো connection string রাখবেন; ব্রাউজারের HTML/JS ফাইলে কখনো নয়।

## ২. ইনস্টল ও পরীক্ষা

```powershell
npm install
npm test
npm start
```

Node.js 22.12 বা নতুন সংস্করণ ব্যবহার করুন। Puppeteer Chrome না পেলে একবার চালান:

```powershell
npx puppeteer browsers install chrome
```

## ৩. সফল সংযোগ যাচাই

সার্ভার চালু হলে লগে `Database: Neon PostgreSQL connected` এবং `[Neon] Connected` দেখা উচিত। `DATABASE_URL` দেওয়া থাকলেও Neon-এ সংযোগ/স্কিমা তৈরিতে সমস্যা হলে সার্ভার চালু হবে না, যাতে ভুল করে local JSON-এ লিখে সফল মনে না হয়।

প্রথম চালুতে স্বয়ংক্রিয়ভাবে `fil_users`, `fil_admin_settings`, `fil_balance_history`, `fil_payments`, `fil_income` টেবিল তৈরি হবে। আগের `.private/users.json`-এর ইউজার থাকলে Neon-এর `fil_users` খালি থাকা অবস্থায় একবার migrate হবে। এরপর Neon user/account ও balance-এর প্রধান storage হবে।

## ৪. গুরুত্বপূর্ণ

- Neon database-এ প্রথমবার admin setting তৈরি হলে `.env`-এর `ADMIN_USERNAME` ও `ADMIN_PASSWORD` ব্যবহার হবে। এরপর admin password পরিবর্তন করতে হলে database setting update করতে হবে; শুধু `.env` বদলালেই existing database admin password বদলাবে না।
- `AUTH_SECRET` বদলাবেন না, এবং শক্তিশালী admin password ব্যবহার করুন।
- `LOCAL_DIRECT_MODE=false` রাখুন যাতে Username/Password login কার্যকর থাকে।
- Payment approval কেবল admin review-এর পর balance যোগ করে; এটি কোনো payment gateway integration নয়।
- এই পরিবেশে আপনার Neon credentials নেই, তাই বাস্তব Neon connection test করা সম্ভব হয়নি। আপনার `.env` বসিয়ে চালালে সংযোগ যাচাই হবে।
