---
id: code-db-drift
title: تطابق الكود مع القاعدة
version: 1
applies_to: PostgreSQL 12+ · MySQL 8.0+ / MariaDB 10.6+ · Laravel 9–11
---

# تطابق الكود مع القاعدة

هذا التخصص يحمي الاتفاق بين ما يفترضه كود Laravel وما تفرضه القاعدة فعلًا: أن كل علاقة يعتمد عليها الكود محمية بمفتاح أجنبي، وأن كل موديل يشير إلى جدول وأعمدة موجودة، وأن الجداول بلا مستخدم معروفة. عندما ينحرف الطرفان تنشأ أخطاء وقت تشغيل لا تكشفها الاختبارات (عمود غير موجود)، أو بيانات يتيمة لا يمنعها أحد (علاقة بلا قيد).

## How to judge (AI)
1. الدليل المقبول: موديل وملف وسطر من الكود المحلَّل (`$table` الصريح أو اسم الجدول بالعرف، العلاقات `belongsTo`/`hasMany`… مع مفاتيحها الحرفية، خصائص الموديل)، مقابل `tables`, `columns`, `relations` في المخطط. اذكر الطرفين دائمًا.
2. الربط بالعرف (`Order` → `orders`) تقريبي: المحلل يجمع الأسماء بقواعد مبسطة لا بـ Inflector الخاص بـ Laravel. إذا لم يكن `$table` صريحًا فالثقة medium على الأكثر في DR02 وDR04.
3. المحلل يقرأ `app/`, `database/migrations/`, `routes/` فقط: لا يرى الحزم في `vendor/`، ولا خدمات أخرى تشارك القاعدة، ولا SQL المكتوب داخل نصوص. "لا يستخدمه الكود" يعني "لا يستخدمه الكود المحلَّل".
4. المخطط المقروء يشمل الجداول العادية والمقسّمة فقط (لا views ولا materialized views ولا foreign tables)، ومن مخططات PostgreSQL المقروءة فقط. موديل يشير إلى شيء من ذلك ليس دليل خطأ.
5. migration لم تُنفذ بعد تفسر كثيرًا من الانحراف: إذا وُجد العمود أو الجدول في `database/migrations` فصِغ النتيجة "migration غير منفذة على هذه القاعدة" واخفض الخطورة إلى info.
6. رتّب: DR02 (خطأ وقت تشغيل مؤكد) ثم DR04 ثم DR01 وDR05 (سلامة مرجعية) ثم DR03.
7. لا تكرر: عمود `*_id` بلا قيد وله علاقة Eloquent يُبلغ عنه في DR01 مع ذكر العلاقة، ولا يُكرر في DR05.
8. علاقات متعددة الأشكال (`morphTo`, `morphMany`, `morphOne`, `morphToMany`, `morphedByMany`) لا يمكن أن يحميها مفتاح أجنبي؛ لا تبلغ عنها أبدًا كعلاقة بلا FK.
9. إضافة مفتاح أجنبي على بيانات قائمة قد تفشل بسبب صفوف يتيمة: كل إصلاح يجب أن يبدأ باستعلام كشف اليتامى ثم `NOT VALID` ثم `VALIDATE`.

## How to judge on MySQL (AI)
1. جداول MyISAM لا تقبل مفاتيح أجنبية أصلًا؛ إصلاح أي علاقة ناقصة عليها يبدأ بتحويل المحرك: `ALTER TABLE t ENGINE=InnoDB`.
2. أنواع Laravel على MySQL: `id()` و`foreignId()` تنتجان `BIGINT UNSIGNED`، و`increments()` تنتج `INT UNSIGNED`. أي مفتاح أجنبي يجب أن يطابق النوع والإشارة تمامًا.
3. أسماء الجداول حساسة لحالة الأحرف على Linux فقط: موديل يعمل على Windows قد يفشل على خادم Linux.

## DR01 · علاقة Eloquent بلا مفتاح أجنبي في القاعدة
- **Severity:** warning — ارفعها إلى error إذا كان الجدول كبيرًا وتُحذف صفوف الأصل فعليًا (الأصل بلا `SoftDeletes`)؛ اخفضها إلى info إذا كان أحد الجدولين جدول سجلات/أرشيف يُقصد أن يحتفظ بالمعرّف بعد حذف الأصل.
- **Confidence:** high عندما تكون المفاتيح حرفية في استدعاء العلاقة أو بالعرف الواضح، والجدولان مربوطان بـ `$table` صريح؛ medium عند الاعتماد على العرف في اسم الجدول أو المفتاح؛ low عندما يتعذر تحديد المفتاح ثابتًا.
- **Detect:** لكل علاقة في موديل معروف الجدول: `belongsTo(Related::class, $fk?, $ownerKey?)`: المصدر جدول الموديل الحالي، العمود `$fk` أو بالعرف `snake(اسم دالة العلاقة) + '_' + مفتاح Related` (عادة `id`)، الهدف جدول Related. `hasOne`/`hasMany(Related::class, $fk?, $localKey?)`: المصدر جدول Related، العمود `$fk` أو `snake(اسم الموديل الحالي) + '_id'`، الهدف جدول الموديل الحالي. `belongsToMany`: الجدول الوسيط (الوسيط الثاني أو اسما الموديلين بالمفرد مرتبين أبجديًا) يحتاج قيدين. النتيجة إذا لم توجد `relation` في المخطط من جدول المصدر إلى جدول الهدف تشمل ذلك العمود.
- **Not a finding when:** العلاقة متعددة الأشكال (`morph*`)؛ الموديلان على اتصالين مختلفين (`$connection`) أو الهدف في مخطط/قاعدة لا يقرؤها المخطط؛ `hasManyThrough`/`hasOneThrough` (افحص العلاقتين المكوّنتين بدلًا منها)؛ المفاتيح أو الموديل الهدف متغيرات لا تُحل ثابتًا؛ مفتاح المالك (`$ownerKey`) ليس فريدًا ولا أساسيًا (لا يمكن إنشاء FK؛ صِغها كتوصية بقيد UNIQUE أولًا)؛ جدول المصدر جدول إطار (`sessions.user_id`).
- **Why it matters:** الكود يفترض أن `$order->user` موجود دائمًا، لكن القاعدة تسمح بقيم تشير إلى صفوف محذوفة أو غير موجودة. النتيجة صفحات تنهار بـ `null` وتقارير تفقد صفوفًا في الـ JOIN، ولا يمكن تنظيف البيانات لاحقًا بثقة.
- **Fix:** اكشف اليتامى ونظّفها، ثم أضف القيد `NOT VALID` (قفل قصير) و`VALIDATE` (لا يمنع القراءة والكتابة)، وتأكد من فهرس العمود (IX01).
```sql
SELECT o.id, o.user_id FROM public.orders o
LEFT JOIN public.users u ON u.id = o.user_id
WHERE o.user_id IS NOT NULL AND u.id IS NULL LIMIT 100;
ALTER TABLE public.orders ADD CONSTRAINT orders_user_id_foreign
    FOREIGN KEY (user_id) REFERENCES public.users (id) NOT VALID;
ALTER TABLE public.orders VALIDATE CONSTRAINT orders_user_id_foreign;
```
```php
DB::statement('ALTER TABLE orders ADD CONSTRAINT orders_user_id_foreign FOREIGN KEY (user_id) REFERENCES users (id) NOT VALID');
DB::statement('ALTER TABLE orders VALIDATE CONSTRAINT orders_user_id_foreign');
// لجدول جديد أو صغير: $table->foreign('user_id')->references('id')->on('users');
```
- **MySQL:** إن كان الجدول MyISAM فلا يمكن إضافة القيد قبل `ALTER TABLE t ENGINE=InnoDB`. وتأكد أن الأنواع متطابقة مع الإشارة: `foreignId()` = `BIGINT UNSIGNED`. قبل الإضافة احسب الصفوف اليتيمة، فالإضافة تفشل بوجودها.
- **References:** https://laravel.com/docs/11.x/eloquent-relationships · https://www.postgresql.org/docs/current/sql-altertable.html · https://www.postgresql.org/docs/current/ddl-constraints.html#DDL-CONSTRAINTS-FK

## DR02 · موديل يشير إلى جدول غير موجود
- **Severity:** error — تبقى error إذا كان الموديل مستخدمًا في Controller أو Service أو علاقة؛ اخفضها إلى info إذا وُجدت migration تنشئ الجدول ولم تُنفذ على هذه القاعدة، أو إذا لم يستخدم الموديل أي كود.
- **Confidence:** high عندما يكون `$table` صريحًا ولا يوجد جدول بهذا الاسم في أي مخطط مقروء؛ medium عند الاعتماد على العرف (التجميع التقريبي قد يخطئ)؛ low إذا كان للموديل `$connection` أو كانت هناك views غير مقروءة.
- **Detect:** صنف غير مجرد في `app/Models/` يرث (مباشرة أو عبر صنف أساس) `Model`, `Authenticatable`, `Pivot`, `MorphPivot`، واسم جدوله (`$table` الصريح، وإلا `plural(snake(اسم الصنف))`، أما `Pivot`/`MorphPivot` فاسمه بالعرف `snake(singular(اسم الصنف))`) لا يطابق أي جدول. `$table` الذي فيه نقطة (`schema.table`) يُطابق بالمخطط والاسم معًا.
- **Not a finding when:** الصنف `abstract` أو صنف أساس لموديلات أخرى؛ الصنف لا يرث Eloquent (DTO أو Enum داخل `app/Models`)؛ للموديل `$connection` مختلف عن الاتصال المقروء؛ الجدول في الواقع view أو materialized view (لا يقرؤها المخطط)؛ الجدول تنشئه migration موجودة لم تُنفذ (صِغها info)؛ الموديل يعرّف `getTable()` بمنطق ديناميكي (جداول مقسّمة يدويًا أو متعددة المستأجرين).
- **Why it matters:** أول استعلام على الموديل يفشل بـ `SQLSTATE[42P01]: Undefined table` في وقت التشغيل، غالبًا في مسار لا تغطيه الاختبارات، أو بعد إعادة تسمية جدول في القاعدة دون تحديث الكود.
- **Fix:** صحّح `$table` ليطابق الجدول الفعلي، أو نفّذ الـ migration الناقصة، أو احذف الموديل المهجور.
```sql
SELECT table_schema, table_name, table_type FROM information_schema.tables
WHERE table_name ILIKE '%order_item%';
```
```php
class OrderItem extends Model {
    protected $table = 'order_items';
}
```
- **MySQL:** على Linux أسماء الجداول حساسة لحالة الأحرف (`lower_case_table_names = 0`): `$table = 'Orders'` يعمل على Windows ويفشل على الخادم.
- **References:** https://laravel.com/docs/11.x/eloquent#table-names · https://laravel.com/docs/11.x/eloquent-relationships#defining-custom-intermediate-table-models

## DR03 · جدول لا يستخدمه أي كود محلَّل
- **Severity:** info — تبقى info دائمًا؛ هذه دعوة للتحقق، لا دليل على أن الجدول مهجور.
- **Confidence:** medium إذا كانت إحصاءات الجدول متوفرة وتُظهر نشاطًا معدومًا (`seq_scan + idx_scan` و`n_tup_ins + n_tup_upd + n_tup_del` صفر منذ التصفير)؛ low في غير ذلك.
- **Detect:** الجدول ضمن `unmatchedTableIds` بعد استبعاد الدليل القادم من `database/migrations` وحدها: لا موديل يشير إليه، ولا `DB::table('name')`/`Schema::…` في `app/`، ولا يظهر كجدول وسيط في `belongsToMany`/`morphToMany`، ولا يشير إليه أي مفتاح أجنبي من جدول مستخدم.
- **Not a finding when:** جداول الإطار والحزم (`migrations`, `jobs`, `job_batches`, `failed_jobs`, `sessions`, `cache`, `cache_locks`, `password_reset_tokens`, `password_resets`, `personal_access_tokens`, `notifications`, `telescope_*`, `pulse_*`, `oauth_*`, `permissions`, `roles`, `model_has_*`, `role_has_permissions`, `activity_log`, `media`)؛ جداول وسيطة لعلاقات `belongsToMany` بالعرف؛ جداول يكتبها trigger أو دالة في القاعدة؛ القاعدة مشتركة مع تطبيق آخر؛ ظهور اسم الجدول في نص SQL خام في الكود (ابحث عن `\bname\b` في النصوص قبل الإصدار)؛ لم يُحلَّل المشروع كاملًا (`failedFiles` أو `skippedFiles` غير فارغة).
- **Why it matters:** الجداول المهجورة تشغل مساحة ووقت نسخ احتياطي وتضلّل من يقرأ المخطط؛ لكن حذف جدول يستخدمه شيء لا يراه المحلل يسبب انقطاعًا وفقدان بيانات، لذلك القرار يحتاج دليل تشغيل لا تحليل كود فقط.
- **Fix:** راقب نشاط الجدول عبر دورة عمل كاملة، ثم أعد تسميته أولًا (يكشف أي مستخدم خفي بخطأ سريع وقابل للتراجع) قبل الحذف النهائي بعد نسخة احتياطية.
```sql
SELECT relname, seq_scan, idx_scan, n_tup_ins, n_tup_upd, n_tup_del, n_live_tup
FROM pg_stat_user_tables WHERE relname = 'legacy_imports';
ALTER TABLE public.legacy_imports RENAME TO legacy_imports_deprecated;
```
```php
Schema::rename('legacy_imports', 'legacy_imports_deprecated');
```
- **MySQL:** إحصاءات النشاط على MySQL من `performance_schema` (إن كان مفعّلًا) وتبدأ من آخر تشغيل للخادم.
- **References:** https://www.postgresql.org/docs/current/monitoring-stats.html#MONITORING-PG-STAT-ALL-TABLES-VIEW · https://laravel.com/docs/11.x/migrations#renaming-and-dropping-tables

## DR04 · الموديل يذكر عمودًا غير موجود في الجدول
- **Severity:** warning — ارفعها إلى error إذا كان العمود في `$fillable` أو `$casts` ويُكتب في مسار معروف (سيفشل INSERT/UPDATE)؛ اخفضها إلى info إذا كان في `$hidden`/`$visible` فقط (لا يكسر شيئًا).
- **Confidence:** high مع `$table` صريح ونص حرفي في الخاصية؛ medium مع الربط بالعرف؛ low إذا كان للموديل casts مخصصة أو accessors قد تفسر الاسم.
- **Detect:** لكل موديل معروف الجدول: الأسماء النصية الحرفية في `$fillable`، و`$guarded` (عدا `*`)، و`$casts` ومصفوفة `casts()`، و`$dates` (Laravel ≤ 9)، و`$hidden`، و`$visible`، والثوابت `CREATED_AT`/`UPDATED_AT`/`DELETED_AT`، و`deleted_at` إذا استخدم `SoftDeletes`، و`created_at`/`updated_at` إذا لم يكن `$timestamps = false`. أي اسم غير موجود في `columns` بعد إزالة مسار JSON (`options->theme` ← `options`).
- **Not a finding when:** الاسم في `$appends` أو له accessor (`getXAttribute` أو دالة `x(): Attribute`)؛ الاسم في `$hidden`/`$visible` هو اسم علاقة في الموديل (إخفاء علاقة محمّلة مشروع)؛ cast مخصص يطبق `CastsAttributes` ويوزع القيمة على أعمدة أخرى (مثل `address` ← `address_line1`, `city`)؛ `$timestamps = false` (لا يُطلب `created_at`)؛ العمود تضيفه migration لم تُنفذ (صِغها info)؛ الاسم متغير أو مبني ديناميكيًا.
- **Why it matters:** `create()`/`update()` بعمود غير موجود يفشل بـ `SQLSTATE[42703]: Undefined column`، وcast على عمود مفقود يخفي أن البيانات لا تُحفظ، وغالبًا يدل ذلك على إعادة تسمية في القاعدة لم تُنقل إلى الكود أو العكس.
- **Fix:** وحّد الاسم في الطرفين: صحّح الموديل، أو أضف العمود بـ migration، أو أزل الاسم المهجور.
```sql
SELECT column_name FROM information_schema.columns
WHERE table_schema = 'public' AND table_name = 'orders' ORDER BY ordinal_position;
```
```php
class Order extends Model {
    protected $fillable = ['user_id', 'total', 'status']; // أزل 'shipping_cost' إن حُذف من الجدول
}
```
- **MySQL:** لا فرق في MySQL.
- **References:** https://laravel.com/docs/11.x/eloquent#mass-assignment · https://laravel.com/docs/11.x/eloquent-mutators#attribute-casting · https://laravel.com/docs/11.x/eloquent-serialization#hiding-attributes-from-json

## DR05 · عمود ربط *_id بلا مفتاح أجنبي
- **Severity:** warning — اخفضها إلى info لجداول السجلات والتدقيق (`*_logs`, `*_log`, `audit*`, `*_history`, `*_events`) التي يُقصد أن تحتفظ بالمعرّف بعد حذف الأصل، وللجداول الصغيرة.
- **Confidence:** high عندما يوجد جدول هدف واحد مطابق بالاسم ونوعه يطابق مفتاحه الأساسي؛ medium عند تطابق الاسم مع اختلاف النوع؛ low عندما يتعدد الهدف المحتمل.
- **Detect:** (مطابق لـ `missing-foreign-key` في `public/lint.js`) عمود اسمه يطابق `^(.+)_id$`، ليس `primary` ولا `foreign` ولا مذكورًا في أي `relation` من جدوله؛ ابحث عن جدول هدف باسم الجذع بالجمع (`user_id` ← `users`، `category_id` ← `categories`، `person_id` ← `people`)، مفضّلًا المخطط نفسه، وله مفتاح أساسي من عمود واحد. إن لم يوجد هدف فليست نتيجة.
- **Not a finding when:** زوج متعدد الأشكال (`<x>_id` مع `<x>_type`، أو `*able_id`)؛ معرّفات خارجية لا تشير إلى جدول محلي (`stripe_id`, `external_id`, `provider_id`, `google_id`, `facebook_id`, `apple_id`, `transaction_id`, `session_id`, `request_id`, `trace_id`, `correlation_id`, `device_id`, `idempotency_key`)؛ النوع `varchar`/`text` والهدف رقمي (غالبًا معرّف خارجي)؛ جداول الإطار (`sessions.user_id`, `personal_access_tokens.tokenable_id`, `notifications.notifiable_id`)؛ العمود له علاقة Eloquent (يُبلغ عنه DR01)؛ الجدول ومصدره في قاعدتين مختلفتين.
- **Why it matters:** بلا قيد تقبل القاعدة معرّفًا لا يقابله صف، فتتراكم صفوف يتيمة بعد كل حذف أو خطأ استيراد، وتعيد الـ JOIN نتائج ناقصة بصمت. هذا أشيع انحراف في مشاريع Laravel التي تستخدم `unsignedBigInteger('x_id')` بدل `foreignId()->constrained()`.
- **Fix:** اكشف اليتامى ونظّفها (حذف أو NULL)، ثم أضف القيد بأمان وفهرسًا على العمود.
```sql
SELECT count(*) FROM public.order_items i
LEFT JOIN public.products p ON p.id = i.product_id
WHERE i.product_id IS NOT NULL AND p.id IS NULL;
ALTER TABLE public.order_items ADD CONSTRAINT order_items_product_id_foreign
    FOREIGN KEY (product_id) REFERENCES public.products (id) NOT VALID;
ALTER TABLE public.order_items VALIDATE CONSTRAINT order_items_product_id_foreign;
```
```php
// لجدول جديد:
$table->foreignId('product_id')->constrained()->restrictOnDelete();
```
- **MySQL:** قبل إضافة القيد ابحث عن الصفوف اليتيمة: `SELECT COUNT(*) FROM child c LEFT JOIN parent p ON p.id = c.parent_id WHERE c.parent_id IS NOT NULL AND p.id IS NULL;` فالإضافة تفشل إن وُجدت. على MyISAM حوّل المحرك أولًا.
- **References:** https://www.postgresql.org/docs/current/ddl-constraints.html#DDL-CONSTRAINTS-FK · https://www.postgresql.org/docs/current/sql-altertable.html · https://laravel.com/docs/11.x/migrations#foreign-key-constraints
