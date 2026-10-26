# Admin Login-এ “Failed to fetch” সমাধান

এই বার্তাটি সাধারণত ব্রাউজার থেকে API সার্ভারে পৌঁছানো যাচ্ছে না বোঝায়; এটি ভুল Password-এর বার্তা নয়।

1. প্রজেক্টের মূল ফোল্ডারে `.env.local` ফাইলটি আছে কি না নিশ্চিত করুন। এতে `ADMIN_USERNAME`, `ADMIN_PASSWORD`, `AUTH_SECRET`, এবং Neon-এর `DATABASE_URL` থাকা উচিত।
2. `npm start` দিয়ে একই প্রজেক্টের সার্ভার চালু করুন এবং টার্মিনালে `Neon PostgreSQL connected` ও `Local: http://localhost:3000` বার্তা দেখুন।
3. একই কম্পিউটারে `http://localhost:3000/admin.html` খুলুন। `file:///.../admin.html` বা অন্য কোনো hosting-এর আলাদা URL থেকে খুলবেন না।
4. `http://localhost:3000/api/health` খুলে JSON response আসে কি না দেখুন। সার্ভার বন্ধ থাকলে বা startup-এ error থাকলে Login-এ “Failed to fetch” দেখা যেতে পারে।
5. Login request হলো একই origin-এ `POST /api/auth/admin-login`, JSON body `{"username":"…","password":"…"}`। ভুল credentials হলে API `401` এবং login error দেয়; “Failed to fetch” মানে browser API server-এ পৌঁছাতে পারেনি। Login screen এখন request endpoint এবং সঠিক app URL দেখায়।
6. Neon-এ admin setting প্রথমবার তৈরি হওয়ার পর `ADMIN_USERNAME`/`ADMIN_PASSWORD` env বদলালেই database-এর বিদ্যমান admin credentials বদলায় না। বিদ্যমান setting-এর username env-এর সঙ্গে না মিললে admin setting-এ সেটি আলাদাভাবে update করুন; password কখনো log বা share করবেন না।
7. `ADMIN_PASSWORD` বা `AUTH_SECRET` পরিবর্তন করলে সার্ভার restart করুন। `.env.local` GitHub-এ আপলোড করবেন না।

যদি সমস্যা থাকে, Terminal-এর startup error এবং `/api/health`-এর response পরীক্ষা করুন; গোপন `DATABASE_URL`, `ADMIN_PASSWORD`, `AUTH_SECRET` শেয়ার করবেন না।
