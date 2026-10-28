---
id: schema-design
title: تصميم المخطط
version: 1
applies_to: PostgreSQL 12+ · MySQL 8.0+ / MariaDB 10.6+ · Laravel 9–11
---

# تصميم المخطط

هذا التخصص يحمي البنية الأساسية للمخطط: أن يكون لكل صف هوية ثابتة، وأن تربط العلاقات أعمدة متوافقة النوع، وألا تتكرر القيود أو تنقطع الجداول عن بقية النموذج. أخطاء التصميم هنا رخيصة الإصلاح قبل امتلاء الجداول بالبيانات ومكلفة جدًا بعده، لأن إصلاحها يتطلب غالبًا إعادة كتابة جداول كبيرة وتعديل الكود الذي يعتمد عليها.

## How to judge (AI)
1. الدليل المقبول هنا هو المخطط فقط: `tables[].columns[]` (`type`, `nullable`, `default`, `primary`, `unique`, `foreign`)، `uniqueKeys`، `indexes`، `relations[]` (`source`, `target`, `pairs`, `onDelete`)، و`approxRows`. اذكر دائمًا `جدول.عمود` واسم القيد.
2. لا تدّعِ أن قيدًا "غير موجود" إلا إذا كان المخطط المقروء يشمل ذلك النوع من القيود؛ القارئ الحالي لا يقرأ CHECK ولا الفهارس الجزئية أو التعبيرية ولا الـ views.
3. رتّب حسب الأثر: نوع مفتاح أجنبي أضيق من الهدف (SD03) قبل غياب المفتاح الأساسي (SD01)، ثم التكرار (SD04)، ثم الجداول الفارغة والمعزولة.
4. ارفع الخطورة درجة إذا كان الجدول كبيرًا (`approxRows ≥ 100,000`) لأن الإصلاح يصبح عملية إعادة كتابة؛ واخفضها درجة لجداول الإطار وجداول الحزم (`migrations`, `jobs`, `failed_jobs`, `sessions`, `cache`, `password_reset_tokens`, `personal_access_tokens`, `telescope_*`, `oauth_*`…).
5. لا تكرر النتيجة نفسها تحت فحصين: عمود `*_id` بلا علاقة يُبلغ عنه في DR05 وليس في SD05؛ الجدول الذي سبب عزلته هو هذا العمود لا يأخذ SD05.
6. `approxRows = 0` لا يعني جدولًا فارغًا ما لم يكن الجدول مضافًا في المسودة؛ قد تكون الإحصاءات لم تُجمع بعد. اخفض الثقة ولا تبنِ عليه حكمًا قاطعًا.
7. عند اقتراح إصلاح على جدول فيه بيانات، استخدم الصيغ الآمنة (`NOT VALID` ثم `VALIDATE`، `CREATE INDEX CONCURRENTLY`) واذكر أن تغيير النوع يعيد كتابة الجدول.
8. لا تقترح حذف جدول أو قيد بناءً على هذا التخصص وحده؛ هذه فحوص بنية وليست دليل استخدام.

## How to judge on MySQL (AI)
1. InnoDB يرتّب الصفوف فعليًا بالمفتاح الأساسي (clustered index)؛ بلا مفتاح يولّد معرّفًا مخفيًا من 6 بايت لا يراه التطبيق ولا ينفع النسخ المتماثل.
2. المحرك يُقرأ من كل جدول: MyISAM لا يدعم مفاتيح أجنبية ولا معاملات، فغياب العلاقات في جدول MyISAM حقيقة عن المحرك لا عن التصميم. اذكر المحرك قبل الحكم.
3. MySQL يرفض إنشاء مفتاح أجنبي بين نوعين مختلفين في الحجم أو الإشارة (signed/unsigned)، فأي عدم تطابق قائم مصدره غالبًا `foreign_key_checks = 0` أو مسودة لم تُنفذ.
4. `lower_case_table_names` يختلف بين Linux (حساس لحالة الأحرف) وWindows/macOS؛ لا تفترض أن اسمين يختلفان بالحالة فقط جدولان مختلفان.

## SD01 · جدول بلا مفتاح أساسي
- **Severity:** warning — ارفعها إلى error إذا كان الجدول كبيرًا ويُحدَّث أو يُحذف منه (أو مستخدمًا في نسخ منطقي)؛ اخفضها إلى info إذا كان له مفتاح فريد على أعمدة كلها NOT NULL.
- **Confidence:** high عندما لا يحمل أي عمود `primary` والجدول ليس من جداول الإطار؛ medium للجداول الوسيطة؛ low إذا كان الجدول مضافًا في المسودة ولم تكتمل أعمدته.
- **Detect:** لكل جدول فيه عمود واحد على الأقل: `columns.every(c => !c.primary)`. سجّل إن كان في `uniqueKeys` أو في أعمدة `unique` مفتاح كل أعمدته `nullable === false` (مفتاح بديل) لأنه يغيّر الخطورة.
- **Not a finding when:** الجدول بلا أعمدة (يتولاه SD02)؛ جداول الإطار القديمة التي صُممت بلا مفتاح مثل `password_resets` (Laravel ≤ 9) وجداول الحزم؛ الجدول الوسيط الذي له `uniqueKeys` على عموديه الأجنبيين وكلاهما NOT NULL (يكفي كهوية، تبقى توصية info فقط إن أردت).
- **Why it matters:** بلا مفتاح أساسي لا يمكن تمييز الصفوف المكررة ولا حذف صف بعينه بثقة، ولا يمكن لجدول آخر الإشارة إليه بعلاقة، والنسخ المنطقي (logical replication) يرفض UPDATE وDELETE على الجدول دون replica identity.
- **Fix:** أضف مفتاحًا بديلًا أو اجعل المفتاح الفريد الحالي أساسيًا. إضافة عمود هوية تعيد كتابة الجدول، فنفّذها في نافذة صيانة للجداول الكبيرة. للجداول الكبيرة ذات المفتاح الفريد ابنِ الفهرس أولًا بشكل متزامن ثم حوّله إلى مفتاح.
```sql
-- جدول صغير أو جديد:
ALTER TABLE public.audit_entries ADD COLUMN id bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY;
-- جدول وسيط له مفتاح طبيعي:
CREATE UNIQUE INDEX CONCURRENTLY role_user_pkey_idx ON public.role_user (role_id, user_id);
ALTER TABLE public.role_user ADD CONSTRAINT role_user_pkey PRIMARY KEY USING INDEX role_user_pkey_idx;
```
```php
Schema::table('role_user', function (Blueprint $table) {
    $table->primary(['role_id', 'user_id']);
});
```
- **MySQL:** InnoDB يستخدم معرّفًا مخفيًا (GEN_CLUST_INDEX) لا يُشار إليه، والنسخ المتماثل بصيغة row يمسح الجدول كاملًا لكل صف معدّل في جدول بلا مفتاح؛ Group Replication و`sql_require_primary_key` (8.0.13+) يرفضانه. الإصلاح: `ALTER TABLE t ADD COLUMN id BIGINT UNSIGNED AUTO_INCREMENT PRIMARY KEY FIRST;` وهو يعيد بناء الجدول.
- **References:** https://www.postgresql.org/docs/current/ddl-constraints.html#DDL-CONSTRAINTS-PRIMARY-KEYS · https://www.postgresql.org/docs/current/sql-altertable.html · https://www.postgresql.org/docs/current/logical-replication-publication.html

## SD02 · جدول بلا أعمدة
- **Severity:** warning — تبقى warning؛ لا ترفعها لأن الجدول الفارغ لا يكسر شيئًا قائمًا، لكنه يدل على مسودة ناقصة أو بقايا.
- **Confidence:** high دائمًا (الحكم بنيوي)؛ medium إذا كان الجدول مقسّمًا أو من امتداد لا يقرأ القارئ أعمدته.
- **Detect:** `table.columns.length === 0`. في المسودة: جدول من عملية `addTable` لم تُتبع بأي `addColumn` لنفس `tableId`.
- **Not a finding when:** لا استثناءات حقيقية؛ لكن إن كان الجدول مضافًا في المسودة الحالية فصِغ النتيجة كتذكير "أكمل الجدول قبل التسليم" بدل "خطأ في القاعدة".
- **Why it matters:** `CREATE TABLE t ()` قانوني في PostgreSQL لكنه بلا فائدة: لا مفتاح ولا بيانات ولا يمكن ربطه، وغالبًا هو جدول نُسي أو عملية مسودة غير مكتملة ستُسلَّم كما هي.
- **Fix:** أضف المفتاح الأساسي والأعمدة في المسودة نفسها، أو احذف الجدول إن كان بقايا.
```sql
ALTER TABLE public.coupons ADD COLUMN id bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY;
```
```php
Schema::create('coupons', function (Blueprint $table) {
    $table->id();
    $table->timestamps();
});
```
- **MySQL:** MySQL لا يسمح بجدول بلا أعمدة إطلاقًا، فهذه النتيجة على MySQL تأتي من المسودة فقط: المخطِط يكتب الجدول الجديد مع الأعمدة التي تضيفها له.
- **References:** https://www.postgresql.org/docs/current/sql-createtable.html

## SD03 · نوع المفتاح الأجنبي لا يطابق المفتاح الذي يشير إليه
- **Severity:** error — error عندما يكون عمود المصدر أضيق من الهدف (`integer` ← `bigint`، `smallint` ← `integer`، `varchar(n)` أقصر من الهدف) أو عندما لا توجد مقارنة مساواة بين النوعين (`uuid` مقابل `varchar`، `integer` مقابل `varchar`)؛ اخفضها إلى warning عندما يكون المصدر أوسع (`bigint` ← `integer`).
- **Confidence:** high عند اختلاف `normalizeType` للطرفين؛ medium إذا كان أحد الطرفين domain أو نوعًا معرّفًا من المستخدم لا يُعرف أصله.
- **Detect:** لكل `relation` ولكل `pair`: قارن `normalizeType(source.type)` مع `normalizeType(target.type)` (يزيل الطول والدقة ويوحّد الأسماء المستعارة). للتمييز بين الأضيق والأوسع استخدم الترتيب `smallint < integer < bigint`، ولـ `varchar(n)` قارن n بطول الهدف من النص الأصلي للنوع.
- **Not a finding when:** الاختلاف اسم مستعار فقط (`int4`/`integer`، `serial`/`integer`، `bigserial`/`bigint`، `timestamp(0) without time zone`/`timestamp`)؛ `varchar` مقابل `text` (متوافقان ثنائيًا)؛ `varchar(n)` حيث n ≥ طول الهدف؛ `unsignedBigInteger` في Laravel لأنه يصبح `bigint` في PostgreSQL أصلًا.
- **Why it matters:** PostgreSQL يقبل مفتاحًا من `integer` إلى `bigint`، لكن العلاقة تنكسر فعليًا حين يتجاوز معرّف الهدف 2,147,483,647: يفشل كل إدراج يشير إلى الصفوف الجديدة. والأنواع التي لا تُقارن مباشرة (`uuid`/`varchar`) يرفض PostgreSQL إنشاء قيدها أصلًا، أو تفرض تحويلًا يمنع استخدام الفهرس في كل ربط.
- **Fix:** وحّد نوع المصدر مع الهدف. تغيير `integer` إلى `bigint` يعيد كتابة الجدول تحت قفل ACCESS EXCLUSIVE؛ للجداول الكبيرة استخدم عمودًا جديدًا مع تعبئة على دفعات (انظر MS03).
```sql
ALTER TABLE public.orders ALTER COLUMN user_id TYPE bigint;  -- يعيد كتابة الجدول
```
```php
// Laravel 11: أعد ذكر كل المعدّلات عند change()
Schema::table('orders', function (Blueprint $table) {
    $table->unsignedBigInteger('user_id')->change();
});
// للأعمدة الجديدة استخدم foreignId() ليطابق id() من نوع bigint
$table->foreignId('user_id')->constrained();
```
- **MySQL:** InnoDB يرفض إنشاء القيد عند اختلاف الحجم أو الإشارة (`INT` مقابل `BIGINT`، أو `UNSIGNED` مقابل signed) بخطأ 3780، ويشترط تطابق charset والـ collation في الأعمدة النصية. اختلاف unsigned خطأ دائمًا على MySQL.
- **References:** https://www.postgresql.org/docs/current/ddl-constraints.html#DDL-CONSTRAINTS-FK · https://www.postgresql.org/docs/current/datatype-numeric.html#DATATYPE-INT · https://laravel.com/docs/11.x/migrations#foreign-key-constraints

## SD04 · علاقة مكررة بين الجدولين نفسيهما
- **Severity:** warning — ارفعها إلى error إذا اختلف `onDelete` بين القيدين المكررين (مثلًا CASCADE وRESTRICT) لأن السلوك الفعلي يصبح متعارضًا وغير متوقع.
- **Confidence:** high عندما تتطابق `source` و`target` ومجموعة الأزواج تمامًا.
- **Detect:** وقّع كل علاقة بـ `source | target | sort(pairs.map(p => p.source + '>' + p.target))`؛ أي توقيع يظهر أكثر من مرة نتيجة، وتُنسب النتيجة إلى القيد الثاني (الأحدث في الترتيب). قارن `onDelete` و`onUpdate` بين المكررات.
- **Not a finding when:** علاقتان بين الجدولين نفسيهما على أعمدة مختلفة (`orders.created_by` و`orders.approved_by` إلى `users`) فهما علاقتان مشروعتان؛ علاقة مركبة وأخرى على جزء من أعمدتها (توقيعان مختلفان)؛ علاقة `kind !== 'actual'` مقترحة في المسودة تطابق قيدًا قائمًا (صغها كتحذير على المسودة: "القيد موجود أصلًا").
- **Why it matters:** كل قيد مكرر يضيف فحصًا ومشغّلات على كل إدراج وتعديل وحذف دون أي حماية إضافية، وإذا اختلفت أفعال الحذف ينفّذ PostgreSQL الاثنين فيفشل الحذف أو يتسلسل بشكل لم يقصده أحد. غالبًا سببه `foreignId()->constrained()` ثم `foreign()` في migration لاحقة.
- **Fix:** احذف القيد الزائد واحتفظ بالذي يحمل فعل الحذف المقصود.
```sql
ALTER TABLE public.orders DROP CONSTRAINT orders_user_id_foreign1;
```
```php
Schema::table('orders', function (Blueprint $table) {
    $table->dropForeign('orders_user_id_foreign1');
});
```
- **MySQL:** MySQL يقبل قيدين مكررين ويسمي غير المسمّى `<table>_ibfk_N`؛ التكرار يأتي غالبًا من خلط قيد Laravel المسمّى بقيد أُضيف يدويًا. احذف أحدهما بـ `ALTER TABLE t DROP FOREIGN KEY name;`.
- **References:** https://www.postgresql.org/docs/current/ddl-constraints.html#DDL-CONSTRAINTS-FK · https://laravel.com/docs/11.x/migrations#foreign-key-constraints

## SD05 · جدول معزول بلا أي علاقة
- **Severity:** info — تبقى info؛ العزلة ليست خطأ بذاتها بل إشارة إلى علاقة ناقصة أو جدول مهجور.
- **Confidence:** medium إذا كان في الجدول أعمدة تشبه الروابط (`*_id`, `*_uuid`) لا تطابق أي جدول؛ low لجداول الإعدادات والسجلات.
- **Detect:** عندما `tables.length ≥ 2`: الجدول لا يظهر في أي `relation.source` ولا `relation.target`.
- **Not a finding when:** جداول الإطار والحزم (`migrations`, `jobs`, `job_batches`, `failed_jobs`, `sessions`, `cache`, `cache_locks`, `password_reset_tokens`, `personal_access_tokens`, `notifications`, `telescope_*`, `pulse_*`)؛ جداول إعدادات أو مراجع مستقلة بطبيعتها (`settings`, `configs`, `options`, `countries` بلا مراجع)؛ جداول ترتبط فقط عبر أعمدة متعددة الأشكال (`<x>_id` + `<x>_type`)؛ جدول فيه عمود `*_id` يطابق جدولًا موجودًا (يُبلغ عنه DR05 بدلًا من هذا الفحص)؛ مخطط من جدول واحد.
- **Why it matters:** جدول معزول في نظام علائقي يعني إما بيانات بلا حماية مرجعية (قيم يتيمة بعد حذف الأصل) وإما جدولًا لم يعد أحد يستخدمه ويشغل مساحة ويضلّل من يقرأ المخطط.
- **Fix:** إن كان الجدول مرتبطًا منطقيًا فأضف العلاقة الناقصة بأمان (انظر DR05)؛ وإن كان مهجورًا فتحقق من الاستخدام (DR03 و`pg_stat_user_tables`) قبل أي حذف.
```sql
SELECT relname, seq_scan, idx_scan, n_tup_ins, n_tup_upd, n_tup_del
FROM pg_stat_user_tables WHERE relname = 'legacy_imports';
```
```php
// إن كانت العلاقة مقصودة:
$table->foreignId('store_id')->constrained();
```
- **MySQL:** جدول MyISAM يبدو معزولًا لأن المحرك لا يحفظ المفاتيح الأجنبية أصلًا؛ تحقق من `ENGINE` قبل اعتباره مهجورًا.
- **References:** https://www.postgresql.org/docs/current/ddl-constraints.html#DDL-CONSTRAINTS-FK · https://www.postgresql.org/docs/current/monitoring-stats.html#MONITORING-PG-STAT-ALL-TABLES-VIEW
