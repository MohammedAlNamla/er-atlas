---
id: data-integrity
title: سلامة البيانات
version: 1
applies_to: PostgreSQL 12+ · MySQL 8.0+ / MariaDB 10.6+ · Laravel 9–11
---

# سلامة البيانات

هذا التخصص يحمي صحة القيم المخزنة نفسها: أن تُحفظ المبالغ بدقة، وأن تقتصر الحالات على قيم معروفة، وأن تتصرف العلاقات عند الحذف كما يتوقع الفريق، وأن يكون للوقت معنى واحد. هذه أخطاء لا تظهر في الاختبارات عادة، بل تظهر بعد أشهر كفروقات محاسبية أو حذف غير مقصود أو تقارير بتوقيت خاطئ، ويصعب إصلاح البيانات التي تلفت قبل اكتشافها.

## How to judge (AI)
1. الدليل الأساسي هو المخطط: `type`, `nullable`, `default` لكل عمود، و`relations[].onDelete` (`a` NO ACTION، `r` RESTRICT، `c` CASCADE، `n` SET NULL، `d` SET DEFAULT)، و`approxRows`. الكود والإحصاءات أدلة مساعدة تغيّر الثقة فقط.
2. اعتمد على النوع المطبّع (`normalizeType`) لا على النص الخام: `float8` = `double precision`، `timestamp(0) without time zone` = `timestamp`.
3. أسماء الأعمدة دليل ظرفي: الاسم وحده يعطي confidence medium على الأكثر، إلا إذا تطابق مع نوع خاطئ واضح (مثل `price double precision`).
4. القارئ الحالي لا يقرأ قيود CHECK. لا تقل "لا يوجد قيد" في DI02 بثقة عالية ما لم يكن `checks` متوفرًا للجدول؛ Laravel ينشئ `enum()` على PostgreSQL كـ `varchar` مع CHECK.
5. رتّب: DI03 وDI07 (يفشل الحذف حتمًا) ثم DI01 (فقدان دقة مالية) ثم DI04 ثم DI06 ثم DI02 وDI05.
6. لا تجمع جداول الإطار والحزم (`jobs`, `failed_jobs`, `sessions`, `cache`, `notifications`, `telescope_*`…) في نتائج DI02 وDI06؛ هي خارج سيطرة الفريق.
7. أي إصلاح يغيّر نوع عمود أو يضيف NOT NULL على جدول فيه بيانات يجب أن يذكر كلفة إعادة الكتابة أو المسح والصيغة الآمنة (CHECK `NOT VALID` ثم `VALIDATE`).
8. لا تدّعِ وجود بيانات تالفة فعلًا (فروقات، NULL، قيم غريبة) إلا إذا قدّمت الإحصاءات (`pg_stats.null_frac`, `n_distinct`) دليلًا؛ صِف الخطر لا الضرر.
9. عند غياب `approxRows` أو كونه صفرًا اخفض الثقة في DI04.

## How to judge on MySQL (AI)
1. سلوك القيم الخاطئة يتبع `sql_mode`: مع `STRICT_TRANS_TABLES` (الافتراضي منذ 5.7) تُرفض، وبدونه تُقصّ أو تُحوّل بصمت. إن لم يُعرف الوضع فاذكر الاحتمالين.
2. قيود CHECK تُفرض في MySQL 8.0.16+ وMariaDB 10.2+؛ في الأقدم تُقبل في التعريف وتُتجاهل.
3. BOOLEAN في MySQL هو `TINYINT(1)` ويقبل أي قيمة من -128 إلى 127، و`ENUM` نوع أصلي يقيّد القيم.
4. TIMESTAMP يُخزن بتوقيت UTC ويُحوّل حسب `time_zone` للجلسة ومداه حتى 2038؛ DATETIME يخزن الوقت كما كُتب بلا منطقة زمنية.

## DI01 · مبلغ مالي مخزّن بنوع عشري تقريبي
- **Severity:** error — تبقى error لأي عمود مالي يدخل في حساب أو مقارنة؛ اخفضها إلى warning إذا كان العمود للعرض أو التقدير فقط (`estimated_*`, `avg_*`).
- **Confidence:** high عندما يطابق الاسم نمط المال والنوع `real` أو `double precision`؛ medium إذا كان الاسم عامًا (`value`, `total`) بلا سياق مالي في الجدول.
- **Detect:** `normalizeType(type)` في (`real`, `double precision`) واسم العمود يطابق `(^|_)(price|amount|total|subtotal|cost|fee|fees|balance|salary|wage|tax|vat|discount|refund|credit|debit|paid|payment|charge|commission|revenue|budget|cash|money)(_|$)`.
- **Not a finding when:** الاسم يحتوي أيضًا رمز نسبة أو قياس: `(rate|ratio|percent|percentage|pct|weight|lat|lng|latitude|longitude|score|distance|quantity|qty|count|duration)` (مثل `tax_rate`, `total_weight`)؛ النوع `numeric`/`decimal` أو عدد صحيح (`bigint` بوحدات صغرى مثل `amount_cents` هو الحل الصحيح)؛ النوع `money` (دقيق لكنه مرتبط بإعداد `lc_monetary`، خارج هذا الفحص).
- **Why it matters:** `real` و`double precision` يخزنان تقريبًا ثنائيًا: `0.1 + 0.2` لا يساوي `0.3`، فتنتج فروقات قروش في المجاميع والضرائب والمقارنات (`where amount = 10.10` قد لا يطابق)، وتفشل المطابقة المحاسبية مع بوابات الدفع.
- **Fix:** حوّل إلى `numeric(p, s)` بدقة كافية، أو خزّن الوحدات الصغرى كعدد صحيح. التحويل يعيد كتابة الجدول (انظر MS03 للجداول الكبيرة)، وراجع القيم بعد التقريب.
```sql
ALTER TABLE public.orders
    ALTER COLUMN total TYPE numeric(12, 2) USING round(total::numeric, 2);
```
```php
Schema::table('orders', function (Blueprint $table) {
    $table->decimal('total', 12, 2)->change();
});
// في الموديل: 'total' => 'decimal:2' (يُرجع نصًا للحفاظ على الدقة)
```
- **MySQL:** `FLOAT` و`DOUBLE` تقريبيان أيضًا، و`FLOAT(M,D)` مهمل منذ 8.0.17. الإصلاح `DECIMAL(14,2)`: `ALTER TABLE t MODIFY COLUMN amount DECIMAL(14,2) NOT NULL;` (يعيد بناء الجدول).
- **References:** https://www.postgresql.org/docs/current/datatype-numeric.html#DATATYPE-NUMERIC-DECIMAL · https://www.postgresql.org/docs/current/datatype-numeric.html#DATATYPE-FLOAT · https://laravel.com/docs/11.x/eloquent-mutators#attribute-casting

## DI02 · عمود حالة نصي بلا قيد يحدد قيمه
- **Severity:** info — ارفعها إلى warning إذا كان الجدول كبيرًا والعمود يقود منطق أعمال (`status`, `state` في جداول الطلبات أو المدفوعات)؛ تبقى info في غير ذلك.
- **Confidence:** high فقط عندما يكون `table.checks` مقروءًا ولا يذكر أي قيد العمود؛ low عندما لا تتوفر قيود CHECK في المخطط المقروء؛ اخفضها درجة إذا كان الموديل يحوّل العمود إلى PHP enum في `$casts`/`casts()` (الكود يتحقق، والقاعدة لا).
- **Detect:** `normalizeType(type)` في (`text`, `varchar`, `char`) واسم العمود يطابق `^(status|state|type|kind|stage|phase|role|level|priority|gender|channel|source|mode|category)$` أو `_(status|state|type|kind|stage|phase|role|level|priority|mode)$`، ولا يوجد في `table.checks` تعريف يذكر العمود.
- **Not a finding when:** العمود نوع enum في PostgreSQL (النوع اسم مخصص لا `varchar`)؛ قيد CHECK أو مفتاح أجنبي إلى جدول مرجعي يقيده (`status_id` ← `statuses`)؛ زوج متعدد الأشكال (`<x>_type` مع `<x>_id`)؛ أعمدة نص حر بطبيعتها (`mime_type`, `content_type`, `media_type`, `file_type`, `token_type`, `user_agent`, `source_url`)؛ `notifications.type` و`jobs`/`failed_jobs` وجداول الحزم؛ migration المشروع تنشئ العمود بـ `->enum()` (ينشئ Laravel قيد CHECK).
- **Why it matters:** بلا قيد تقبل القاعدة أي نص: `'Paid'` و`'paid '` و`'payed'` قيم مختلفة، فتسقط صفوف من التقارير ومن شروط `where('status', 'paid')`، وأي كتابة لا تمر بالموديل (SQL مباشر، خدمة أخرى، استيراد) تتجاوز تحقق التطبيق.
- **Fix:** نظّف القيم الموجودة، ثم أضف القيد `NOT VALID` (لا يفحص القديم، قفل قصير) ثم `VALIDATE` (يفحص دون منع القراءة والكتابة).
```sql
SELECT status, count(*) FROM public.orders GROUP BY status ORDER BY 2 DESC;
ALTER TABLE public.orders ADD CONSTRAINT orders_status_check
    CHECK (status IN ('pending', 'paid', 'shipped', 'cancelled')) NOT VALID;
ALTER TABLE public.orders VALIDATE CONSTRAINT orders_status_check;
```
```php
DB::statement("ALTER TABLE orders ADD CONSTRAINT orders_status_check CHECK (status IN ('pending','paid','shipped','cancelled')) NOT VALID");
DB::statement('ALTER TABLE orders VALIDATE CONSTRAINT orders_status_check');
// وفي الموديل: 'status' => OrderStatus::class (PHP backed enum)
```
- **MySQL:** MySQL يملك `ENUM` أصليًا (القارئ يعلّم العمود `enum`) وهو حل مقبول؛ إضافة قيمة في آخر القائمة فورية (INSTANT) لكن إعادة ترتيبها أو حذف قيمة تعيد بناء الجدول. قيد CHECK بديل يُفرض من 8.0.16.
- **References:** https://www.postgresql.org/docs/current/ddl-constraints.html#DDL-CONSTRAINTS-CHECK-CONSTRAINTS · https://www.postgresql.org/docs/current/sql-altertable.html · https://laravel.com/docs/11.x/eloquent-mutators#enum-casting

## DI03 · SET NULL على عمود لا يقبل NULL
- **Severity:** error — تبقى error دائمًا؛ السلوك المعلن (تفريغ الربط) مستحيل وسيفشل الحذف.
- **Confidence:** high عندما `onDelete === 'n'` وعمود مصدر واحد على الأقل `nullable === false`؛ medium للقيود المركبة على PostgreSQL 15+ (قد تحدد `SET NULL (col)` أعمدة بعينها لا يقرؤها القارئ).
- **Detect:** لكل `relation` حيث `onDelete === 'n'` أو `onUpdate === 'n'`: الأعمدة `pairs.map(p => p.source)` التي `nullable === false` في جدول المصدر. يشمل العلاقات المقترحة في المسودة (`addRelation` مع `onDelete: 'n'`) والأعمدة التي تجعلها المسودة NOT NULL (`updateColumn` بـ `patch.nullable === false`).
- **Not a finding when:** كل أعمدة المصدر تقبل NULL؛ على PostgreSQL 15+ القيد يحدد قائمة أعمدة `SET NULL (…)` كلها تقبل NULL (إن توفرت المعلومة).
- **Why it matters:** عند حذف صف الأصل يحاول PostgreSQL وضع NULL في الصفوف المرتبطة فيصطدم بقيد NOT NULL، فيفشل الحذف كله بخطأ `not-null constraint` غامض للمستخدم. النتيجة عمليًا RESTRICT مقنّع، وغالبًا سببها `->nullOnDelete()` على `foreignId()` بلا `->nullable()`.
- **Fix:** قرر السلوك المقصود: إما اجعل العمود يقبل NULL، أو غيّر الفعل إلى `RESTRICT`/`CASCADE`. تغيير الفعل يتطلب حذف القيد وإعادة إنشائه؛ للجداول الكبيرة استخدم `NOT VALID` ثم `VALIDATE`.
```sql
-- الخيار 1: السماح بـ NULL (سريع، لا يعيد الكتابة)
ALTER TABLE public.orders ALTER COLUMN coupon_id DROP NOT NULL;
-- الخيار 2: تغيير الفعل
BEGIN;
ALTER TABLE public.orders DROP CONSTRAINT orders_coupon_id_foreign;
ALTER TABLE public.orders ADD CONSTRAINT orders_coupon_id_foreign
    FOREIGN KEY (coupon_id) REFERENCES public.coupons (id) ON DELETE RESTRICT NOT VALID;
COMMIT;
ALTER TABLE public.orders VALIDATE CONSTRAINT orders_coupon_id_foreign;
```
```php
$table->foreignId('coupon_id')->nullable()->constrained()->nullOnDelete();
```
- **MySQL:** InnoDB يرفض إنشاء قيد SET NULL على عمود NOT NULL (خطأ 1830)، ويرفض لاحقًا جعل العمود NOT NULL ما دام القيد قائمًا؛ النتيجة على MySQL تأتي عادة من المسودة، وتنفيذها سيفشل.
- **References:** https://www.postgresql.org/docs/current/ddl-constraints.html#DDL-CONSTRAINTS-FK · https://laravel.com/docs/11.x/migrations#foreign-key-constraints

## DI04 · حذف متسلسل (CASCADE) إلى جدول كبير
- **Severity:** warning — ارفعها إلى error إذا كان عمود المصدر بلا فهرس (IX01) أو إذا كان التسلسل يستمر إلى جدول كبير آخر؛ اخفضها إلى info إذا كان متوسط الأبناء لكل أصل صغيرًا (`child.approxRows / parent.approxRows ≤ 100`).
- **Confidence:** high عندما `approxRows` للمصدر معروف وكبير؛ medium إذا كان موديل الأصل يستخدم `SoftDeletes` (الحذف الفعلي نادر)؛ low إذا كان `approxRows` صفرًا أو غير معروف.
- **Detect:** لكل `relation` حيث `onDelete === 'c'` وجدول المصدر (`relation.source`) `approxRows ≥ 100,000`. تتبّع السلسلة: إذا كان جدول المصدر نفسه هدفًا لعلاقة `c` أخرى فأدرج المسار كاملًا (`stores → orders → order_items`).
- **Not a finding when:** جدول المصدر جدول وسيط (CASCADE هو التصميم الصحيح لصفوف الربط)؛ جدول المصدر صغير؛ الأصل يُحذف دائمًا صفًا صفًا وأبناؤه قلة (بنود الطلب لطلب واحد)؛ الأصل جدول إطار (`users` → `personal_access_tokens` و`sessions`).
- **Why it matters:** حذف صف واحد في الأصل قد يحذف ملايين الصفوف في معاملة واحدة: أقفال طويلة على الجداول التابعة، وانفجار في WAL والنسخ المتماثل، وكل ذلك بلا تحذير وبلا تراجع إذا كان الحذف خطأً (حذف متجر بالخطأ يمحو كل طلباته).
- **Fix:** استبدل CASCADE بـ RESTRICT واحذف الأبناء صراحة على دفعات في Job، أو اعتمد الحذف المنطقي للأصل. وتأكد من فهرس عمود المصدر.
```sql
BEGIN;
ALTER TABLE public.orders DROP CONSTRAINT orders_store_id_foreign;
ALTER TABLE public.orders ADD CONSTRAINT orders_store_id_foreign
    FOREIGN KEY (store_id) REFERENCES public.stores (id) ON DELETE RESTRICT NOT VALID;
COMMIT;
ALTER TABLE public.orders VALIDATE CONSTRAINT orders_store_id_foreign;
```
```php
$table->foreignId('store_id')->constrained()->restrictOnDelete();
// والحذف على دفعات:
Order::where('store_id', $store->id)->chunkById(1000, fn ($orders) => $orders->each->delete());
```
- **MySQL:** الحذف المتسلسل في InnoDB يتم صفًا صفًا داخل المعاملة، ولا يُطلق triggers على الصفوف المحذوفة بالتسلسل، وعمقه محدود بـ 15 مستوى. على جدول كبير يطيل الأقفال ويضخم الـ undo log.
- **References:** https://www.postgresql.org/docs/current/ddl-constraints.html#DDL-CONSTRAINTS-FK · https://laravel.com/docs/11.x/migrations#foreign-key-constraints · https://laravel.com/docs/11.x/eloquent#soft-deleting

## DI05 · عمود منطقي يقبل NULL بلا قيمة افتراضية
- **Severity:** info — تبقى info؛ ارفعها إلى warning إذا كان العمود صلاحية أو علامة أمان (`is_admin`, `is_active`, `is_blocked`, `is_verified`).
- **Confidence:** high إذا كانت `pg_stats.null_frac` للعمود أكبر من صفر أو غير متوفرة والكود لا يستخدم `whereNull` على العمود؛ medium بلا أي دليل استخدام؛ low إذا كان الكود يفرّق صراحة بين NULL وfalse.
- **Detect:** `normalizeType(type) === 'boolean'` و`nullable === true` و`default` فارغ أو `NULL`.
- **Not a finding when:** الحالة الثالثة مقصودة وموثقة (الكود يستخدم `whereNull('x')` أو يعرض "غير محدد"، مثل `marketing_consent` قبل سؤال المستخدم)؛ العمود مضاف في المسودة مع خطة تعبئة ثم NOT NULL؛ جداول الإطار والحزم.
- **Why it matters:** NULL في عمود منطقي يكسر المنطق الثنائي: `WHERE NOT is_active` لا يعيد صفوف NULL، و`where('is_active', false)` في Laravel لا يطابقها، فيختفي مستخدمون من القوائم أو يُعاملون بصلاحيات غير متوقعة.
- **Fix:** حدد القيمة الافتراضية، املأ الصفوف القديمة، ثم امنع NULL بالطريقة الآمنة (PostgreSQL 12+ يتخطى المسح عند وجود CHECK صالح).
```sql
ALTER TABLE public.users ALTER COLUMN is_active SET DEFAULT false;
UPDATE public.users SET is_active = false WHERE is_active IS NULL; -- على دفعات للجداول الكبيرة
ALTER TABLE public.users ADD CONSTRAINT users_is_active_not_null CHECK (is_active IS NOT NULL) NOT VALID;
ALTER TABLE public.users VALIDATE CONSTRAINT users_is_active_not_null;
ALTER TABLE public.users ALTER COLUMN is_active SET NOT NULL;
ALTER TABLE public.users DROP CONSTRAINT users_is_active_not_null;
```
```php
$table->boolean('is_active')->default(false)->nullable(false)->change();
```
- **MySQL:** `BOOLEAN` هو `TINYINT(1)` ويقبل 2 و-1 أيضًا، فالمشكلة أوسع من NULL. الإصلاح: `MODIFY COLUMN is_active TINYINT(1) NOT NULL DEFAULT 0` وقيد `CHECK (is_active IN (0, 1))` على 8.0.16+.
- **References:** https://www.postgresql.org/docs/current/sql-altertable.html · https://www.postgresql.org/docs/current/functions-comparison.html

## DI06 · وقت حدث مخزّن بلا منطقة زمنية
- **Severity:** info — تبقى info؛ ارفعها إلى warning إذا كانت القاعدة تُكتب من أكثر من تطبيق أو منطقة زمنية، أو كانت الأعمدة تُستخدم في فوترة أو جدولة.
- **Confidence:** medium للأعمدة التي يكتبها الفريق (`paid_at`, `expires_at`)؛ low عندما تقتصر النتيجة على أعمدة Laravel القياسية (`created_at`, `updated_at`, `deleted_at`, `email_verified_at`) لأن `timestamps()` ينشئها بلا منطقة زمنية افتراضيًا ويخزن Laravel فيها بتوقيت `app.timezone` (عادة UTC).
- **Detect:** `normalizeType(type) === 'timestamp'` (أي `timestamp[(p)] without time zone`). أصدر **نتيجة واحدة لكل جدول** تذكر كل أعمدته المطابقة، لا نتيجة لكل عمود.
- **Not a finding when:** النوع `timestamptz` أو `date` أو `time`؛ العمود يمثل وقتًا محليًا مقصودًا بلا لحظة مطلقة (موعد متكرر "الساعة 9 صباحًا بتوقيت الفرع" مع عمود منطقة زمنية مجاور مثل `timezone`)؛ جداول الإطار والحزم (`jobs`, `failed_jobs`, `telescope_*`, `notifications`).
- **Why it matters:** `timestamp` يخزن ساعة حائط بلا مرجع؛ لا يعرف القارئ هل `2026-03-01 10:00` بتوقيت UTC أم الرياض. أي خادم أو أداة بتوقيت مختلف، أو مقارنة مع `now()` (من نوع `timestamptz`) تحوّل القيمة بتوقيت الجلسة، فتنزاح التقارير والجدولة بساعات.
- **Fix:** للأعمدة الجديدة استخدم `timestamptz` (`timestampsTz()` في Laravel) واضبط `'timezone' => 'UTC'` في اتصال pgsql ليطابق `app.timezone`. لتحويل عمود قائم قيمه بتوقيت UTC: على PostgreSQL 12+ يتجنب التحويل إعادة الكتابة إذا كانت `TimeZone` للجلسة UTC وكان التحويل مباشرًا (بلا `USING` أو بـ `USING col::timestamptz` فقط، لا `AT TIME ZONE`). إذا كانت القيم بتوقيت آخر فاستخدم `USING … AT TIME ZONE` (يعيد الكتابة).
```sql
SET TIME ZONE 'UTC';
ALTER TABLE public.payments ALTER COLUMN paid_at TYPE timestamptz;
-- قيم مخزنة بتوقيت محلي:
-- ALTER TABLE public.payments ALTER COLUMN paid_at TYPE timestamptz USING paid_at AT TIME ZONE 'Asia/Riyadh';
```
```php
$table->timestampTz('paid_at')->nullable();
$table->timestampsTz();
// config/database.php → 'pgsql' => [..., 'timezone' => 'UTC']
```
- **MySQL:** على MySQL النوع بلا منطقة زمنية هو `DATETIME`؛ أما `TIMESTAMP` فيُخزن UTC ويُحوّل حسب `time_zone` للجلسة، لكنه ينتهي في 2038-01-19. Laravel ينشئ `timestamps()` كـ `TIMESTAMP` على MySQL. الحل الشائع: `DATETIME` مع ضبط `app.timezone` و`time_zone` للاتصال على UTC.
- **References:** https://www.postgresql.org/docs/current/datatype-datetime.html · https://wiki.postgresql.org/wiki/Don%27t_Do_This · https://laravel.com/docs/11.x/migrations#available-column-types

## DI07 · SET DEFAULT على عمود إلزامي بلا قيمة افتراضية
- **Severity:** error — تبقى error دائمًا؛ الحذف من جدول الهدف سيفشل حتمًا.
- **Confidence:** high عندما `onDelete === 'd'` وعمود مصدر `nullable === false` و`default` فارغ؛ medium للقيود المركبة على PostgreSQL 15+ (قد تحدد `SET DEFAULT (col)` أعمدة بعينها لا يقرؤها القارئ).
- **Detect:** لكل `relation` حيث `onDelete === 'd'` أو `onUpdate === 'd'`: الأعمدة `pairs.map(p => p.source)` في جدول المصدر التي `nullable === false` و`default` فارغ (`null`, `undefined`, `''`). يشمل العلاقات المقترحة في المسودة (`addRelation` مع `onDelete: 'd'`) وعمليات `updateColumn` التي تزيل القيمة الافتراضية أو تجعل العمود NOT NULL.
- **Not a finding when:** للعمود قيمة افتراضية (لكن نبّه في الشرح إذا كانت القيمة لا تقابل صفًا في جدول الهدف: يفشل الحذف حينها بخطأ مفتاح أجنبي، لأن PostgreSQL يتحقق من القيمة الجديدة)؛ العمود يقبل NULL (القيمة الافتراضية الضمنية NULL فيتصرف كـ SET NULL).
- **Why it matters:** عند حذف صف الأصل يضع PostgreSQL القيمة الافتراضية في الصفوف المرتبطة؛ بلا قيمة افتراضية تكون NULL فتصطدم بقيد NOT NULL ويفشل الحذف كله. النتيجة RESTRICT مقنّع برسالة مضللة.
- **Fix:** إما أعطِ العمود قيمة افتراضية تشير إلى صف موجود ومحمي من الحذف (مثل تصنيف "غير مصنف")، أو غيّر الفعل إلى `RESTRICT`/`CASCADE`/`SET NULL` مع جعل العمود يقبل NULL.
```sql
-- الخيار 1: قيمة افتراضية لصف موجود
ALTER TABLE public.products ALTER COLUMN category_id SET DEFAULT 1; -- id لـ "غير مصنف"
-- الخيار 2: تغيير الفعل
BEGIN;
ALTER TABLE public.products DROP CONSTRAINT products_category_id_foreign;
ALTER TABLE public.products ADD CONSTRAINT products_category_id_foreign
    FOREIGN KEY (category_id) REFERENCES public.categories (id) ON DELETE RESTRICT NOT VALID;
COMMIT;
ALTER TABLE public.products VALIDATE CONSTRAINT products_category_id_foreign;
```
```php
$table->foreignId('category_id')->default(1)->constrained()->onDelete('set default');
// أو: $table->foreignId('category_id')->constrained()->restrictOnDelete();
```
- **MySQL:** InnoDB لا يدعم `SET DEFAULT` في المفاتيح الأجنبية أصلًا: المحلل يقبله وInnoDB يرفض التعريف. على MySQL كل قيد SET DEFAULT خطأ بغض النظر عن القيمة الافتراضية؛ استبدله بـ `SET NULL` أو `RESTRICT`.
- **References:** https://www.postgresql.org/docs/current/ddl-constraints.html#DDL-CONSTRAINTS-FK · https://laravel.com/docs/11.x/migrations#foreign-key-constraints
