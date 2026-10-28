---
id: migration-safety
title: أمان تنفيذ المسودة
version: 1
applies_to: PostgreSQL 12+ · MySQL 8.0+ / MariaDB 10.6+ · Laravel 9–11
---

# أمان تنفيذ المسودة

هذا التخصص يحمي لحظة تنفيذ المسودة على قاعدة حية: ألا تفشل العملية في منتصفها، وألا تقفل جدولًا كبيرًا دقائق فيتوقف التطبيق، وألا تحذف أو تعيد تسمية شيء ما زال الكود المنشور يعتمد عليه. أغلب حوادث الإنتاج المتعلقة بالقواعد تأتي من migration صحيحة منطقيًا لكنها نُفذت بالصيغة غير الآمنة على جدول فيه بيانات.

## How to judge (AI)
1. الدليل المقبول: عملية من المسودة (`addColumn`, `updateColumn`, `dropColumn`, `dropTable`, `renameTable`, `addIndex`, `addRelation`, `dropRelation`, `addTable`) مع `tableId`/`columnName`، و`approxRows` للجدول قبل التنفيذ، وSQL الناتج من المخطِط، ومراجع الكود (`file:line`) في MS04.
2. جدول أنشأته المسودة نفسها (`addTable`) فارغ بالتعريف: لا تبلغ عنه في MS01 وMS02 وMS03 وMS05.
3. `approxRows = 0` لجدول قائم لا يعني أنه فارغ؛ قد لا تكون الإحصاءات جُمعت. اخفض الثقة إلى medium وانصح بـ `SELECT count(*)` أو `EXISTS` قبل التنفيذ.
4. صف الأثر بدقة: هل تفشل العملية (MS01، MS02 مع وجود NULL)، أم تقفل (نوع القفل: ACCESS EXCLUSIVE يمنع القراءة والكتابة، SHARE يمنع الكتابة فقط)، أم تكسر الكود (MS04). لا تخلط بينها.
5. رتّب: ما يفشل حتمًا أو يكسر الكود (MS01، MS04) ثم ما يقفل جدولًا كبيرًا (MS03، MS07، MS05، MS06، MS02).
6. كل إصلاح يقترح صيغة آمنة قابلة للتنفيذ على مراحل، ويذكر أن Laravel يغلّف كل migration في معاملة على PostgreSQL، فالعمليات التي لا تعمل داخل معاملة (`CONCURRENTLY`) تحتاج `public $withinTransaction = false;` وmigration مستقلة.
7. انصح بضبط `lock_timeout` قبل أي ALTER على جدول مزدحم، لأن انتظار القفل نفسه يوقف كل الاستعلامات التي تصطف خلفه.
8. لا تفترض ترتيب النشر (كود قبل قاعدة أو العكس)؛ إذا كان الأمان يعتمد عليه فاذكر الترتيب المطلوب صراحة.
9. لا تحكم بأن الكود "لن يتأثر" في MS04 لمجرد عدم العثور على مرجع؛ المحلل لا يرى SQL داخل النصوص ولا الأعمدة الديناميكية ولا الخدمات الأخرى.

## How to judge on MySQL (AI)
1. DDL في MySQL ليس جزءًا من المعاملات: كل `ALTER` يُنهي المعاملة الحالية ضمنيًا، فـ migration فشلت في منتصفها تترك القاعدة نصف معدّلة ولا يستطيع Laravel التراجع عنها.
2. خوارزميات الـ online DDL: `INSTANT` (إضافة عمود منذ 8.0.12، في أي موضع منذ 8.0.29)، `INPLACE` (يسمح بالكتابة غالبًا)، `COPY` (يعيد بناء الجدول ويمنع الكتابة). اقترح تحديد `ALGORITHM` و`LOCK` صراحة ليفشل الأمر بدل أن ينتقل لخوارزمية أبطأ بصمت.
3. أي `ALTER` ينتظر قفل metadata؛ استعلام طويل مفتوح يجعل الـ ALTER ينتظر ويحجز كل الاستعلامات خلفه. للجداول الضخمة اقترح gh-ost أو pt-online-schema-change.

## MS01 · إضافة عمود NOT NULL بلا قيمة افتراضية إلى جدول فيه بيانات
- **Severity:** error — تبقى error لأن العملية تفشل حتمًا إذا كان في الجدول صف واحد؛ اخفضها إلى info إذا ثبت أن الجدول فارغ.
- **Confidence:** high عندما `approxRows > 0`؛ medium عندما `approxRows = 0` لجدول قائم (قد تكون الإحصاءات غير مجموعة).
- **Detect:** عملية `addColumn` حيث `column.nullable === false` و`column.default` فارغ (`null`, `undefined`, `''`) والجدول (`tableId`) ليس مضافًا بـ `addTable` في المسودة نفسها، والنوع ليس `serial`/`bigserial`/`smallserial` (لها قيمة افتراضية ضمنية).
- **Not a finding when:** الجدول جديد في المسودة؛ للعمود قيمة افتراضية؛ النوع serial؛ الجدول فارغ مؤكدًا. القيمة الافتراضية المتغيرة (`gen_random_uuid()`) والأعمدة serial لا تفشل لكنها تعيد كتابة الجدول: يتولاها MS07.
- **Why it matters:** PostgreSQL يرفض العملية بخطأ `column "x" of relation "t" contains null values` لأن الصفوف القائمة ستأخذ NULL. المسودة تتوقف في منتصفها، وإذا لم تكن داخل معاملة تبقى القاعدة في حالة جزئية.
- **Fix:** إما قيمة افتراضية ثابتة (سريعة بلا إعادة كتابة منذ PostgreSQL 11)، أو إضافة العمود nullable ثم التعبئة على دفعات ثم NOT NULL بالطريقة الآمنة (MS02).
```sql
-- الخيار 1: افتراضي ثابت، تعديل بيانات وصفية فقط
ALTER TABLE public.orders ADD COLUMN source text NOT NULL DEFAULT 'web';
-- الخيار 2: على مراحل
ALTER TABLE public.orders ADD COLUMN region_id bigint;
UPDATE public.orders SET region_id = 1 WHERE region_id IS NULL AND id BETWEEN 1 AND 50000; -- كرر بدفعات
ALTER TABLE public.orders ADD CONSTRAINT orders_region_id_not_null CHECK (region_id IS NOT NULL) NOT VALID;
ALTER TABLE public.orders VALIDATE CONSTRAINT orders_region_id_not_null;
ALTER TABLE public.orders ALTER COLUMN region_id SET NOT NULL;
ALTER TABLE public.orders DROP CONSTRAINT orders_region_id_not_null;
```
```php
Schema::table('orders', function (Blueprint $table) {
    $table->string('source')->default('web'); // NOT NULL افتراضيًا في Laravel
});
```
- **MySQL:** MySQL لا يفشل هنا: يملأ الصفوف القائمة بالقيمة الضمنية للنوع (`0`، `''`، أو تاريخ صفري) بصمت، وهذا أسوأ لأنه يكتب بيانات خاطئة. على MySQL هذه النتيجة تحذير عن بيانات صامتة لا عن فشل.
- **References:** https://www.postgresql.org/docs/current/sql-altertable.html · https://www.postgresql.org/docs/current/ddl-alter.html#DDL-ALTER-ADDING-A-COLUMN · https://laravel.com/docs/11.x/migrations#column-modifiers

## MS02 · جعل عمود NOT NULL في جدول فيه بيانات
- **Severity:** warning — ارفعها إلى error إذا كانت `pg_stats.null_frac` للعمود أكبر من صفر (ستفشل العملية)؛ اخفضها إلى info إذا كان الجدول صغيرًا (`approxRows < 10,000`) فالمسح لحظي.
- **Confidence:** high عندما الجدول كبير أو `null_frac > 0`؛ medium بلا إحصاءات؛ low إذا كان `approxRows = 0`.
- **Detect:** عملية `updateColumn` حيث `patch.nullable === false` والعمود قبلها `nullable === true`، والجدول ليس جديدًا في المسودة، و`approxRows > 0` أو غير معروف. سجّل `null_frac` من `pg_stats` إن توفرت، وما إذا كان على الجدول CHECK صالح `(col IS NOT NULL)` (يلغي المسح).
- **Not a finding when:** الجدول جديد في المسودة أو فارغ مؤكدًا؛ يوجد قيد CHECK مُتحقق منه (`convalidated`) بصيغة `col IS NOT NULL` فيتخطى PostgreSQL 12+ المسح؛ المسودة نفسها تضيف قبلها خطوة CHECK `NOT VALID` و`VALIDATE`.
- **Why it matters:** `SET NOT NULL` يأخذ قفل ACCESS EXCLUSIVE ويمسح الجدول كاملًا للتحقق، فتتوقف كل القراءات والكتابات طوال المسح على جدول كبير؛ وإذا وُجد صف NULL واحد تفشل العملية بعد كل هذا الانتظار.
- **Fix:** املأ القيم الفارغة على دفعات، ثم CHECK `NOT VALID` (قفل لحظي) و`VALIDATE` (قفل SHARE UPDATE EXCLUSIVE لا يمنع القراءة والكتابة)، ثم `SET NOT NULL` بلا مسح، ثم احذف الـ CHECK.
```sql
SELECT null_frac FROM pg_stats WHERE schemaname = 'public' AND tablename = 'users' AND attname = 'phone';
SET lock_timeout = '3s';
ALTER TABLE public.users ADD CONSTRAINT users_phone_not_null CHECK (phone IS NOT NULL) NOT VALID;
ALTER TABLE public.users VALIDATE CONSTRAINT users_phone_not_null;
ALTER TABLE public.users ALTER COLUMN phone SET NOT NULL;
ALTER TABLE public.users DROP CONSTRAINT users_phone_not_null;
```
```php
DB::statement('ALTER TABLE users ADD CONSTRAINT users_phone_not_null CHECK (phone IS NOT NULL) NOT VALID');
DB::statement('ALTER TABLE users VALIDATE CONSTRAINT users_phone_not_null');
Schema::table('users', function (Blueprint $table) {
    $table->string('phone')->nullable(false)->change(); // Laravel 11: أعد ذكر كل المعدّلات؛ Laravel ≤ 10 يحتاج doctrine/dbal
});
DB::statement('ALTER TABLE users DROP CONSTRAINT users_phone_not_null');
```
- **MySQL:** `MODIFY COLUMN … NOT NULL` يعيد بناء الجدول؛ مع وضع strict يفشل إن وُجدت قيم NULL، وبدونه يحوّلها بصمت إلى القيمة الضمنية. املأ القيم الفارغة أولًا بتحديث على دفعات.
- **References:** https://www.postgresql.org/docs/current/sql-altertable.html · https://www.postgresql.org/docs/current/view-pg-stats.html · https://laravel.com/docs/11.x/migrations#modifying-columns

## MS03 · تغيير نوع عمود في جدول كبير يعيد كتابته
- **Severity:** warning — ارفعها إلى error إذا كان الجدول ضخمًا (`≥ 10,000,000`) أو كان العمود مفتاحًا أساسيًا تشير إليه مفاتيح أجنبية (يلزم تغييرها أيضًا)؛ اخفضها إلى info بين 10,000 و100,000 صف؛ ليست نتيجة تحت 10,000.
- **Confidence:** high عندما التحويل خارج قائمة التحويلات بلا إعادة كتابة والجدول كبير؛ medium عندما `approxRows` غير معروف أو أحد النوعين domain/نوع مخصص.
- **Detect:** عملية `updateColumn` حيث `patch.type` يختلف عن النوع الحالي، والجدول ليس جديدًا في المسودة، و`approxRows ≥ 100,000`. التحويلات التي **لا** تعيد الكتابة (لا تُبلغ عنها): `varchar(n)` ← `varchar(m)` حيث m ≥ n؛ `varchar(n)` ← `varchar` أو `text`؛ `text` ← `varchar` بلا طول؛ `numeric(p,s)` ← `numeric(p2,s)` حيث p2 ≥ p والمقياس نفسه؛ `numeric(p,s)` ← `numeric`؛ تغيير الاسم المستعار فقط (`int4` ← `integer`)؛ `timestamp` ↔ `timestamptz` على PostgreSQL 12+ عندما `TimeZone` للجلسة UTC. كل ما عدا ذلك يعيد الكتابة، ومنه الشائع: `integer` ← `bigint`، `real`/`double precision` ← `numeric`، تقصير `varchar`، `varchar` ← `uuid`/`integer`/`jsonb`.
- **Not a finding when:** التحويل ضمن القائمة أعلاه؛ الجدول جديد في المسودة أو صغير؛ تغيير النوع جزء من خطة عمود جديد وتعبئة (المسودة تضيف عمودًا جديدًا بدل تعديل القائم).
- **Why it matters:** `ALTER COLUMN TYPE` المعيد للكتابة يأخذ قفل ACCESS EXCLUSIVE وينسخ الجدول كاملًا ويعيد بناء كل فهارسه، فيتوقف التطبيق كليًا على هذا الجدول طوال العملية ويحتاج مساحة قرص تقارب ضعف حجم الجدول. وإذا فشل التحويل في صف واحد (`USING` لا يصلح للقيمة) تُلغى العملية كلها بعد كل هذا.
- **Fix:** للجداول الكبيرة: عمود جديد بالنوع الصحيح، مزامنة بـ trigger، تعبئة على دفعات، فهرس متزامن، ثم تبديل في معاملة قصيرة. في نافذة صيانة مقبولة: نفّذ مباشرة مع `lock_timeout`.
```sql
ALTER TABLE public.events ADD COLUMN id_new bigint;
CREATE FUNCTION events_sync_id() RETURNS trigger LANGUAGE plpgsql AS
$$ BEGIN NEW.id_new := NEW.id; RETURN NEW; END $$;
CREATE TRIGGER events_sync_id BEFORE INSERT OR UPDATE ON public.events
    FOR EACH ROW EXECUTE FUNCTION events_sync_id();
UPDATE public.events SET id_new = id WHERE id BETWEEN 1 AND 100000 AND id_new IS NULL; -- كرر بدفعات
CREATE UNIQUE INDEX CONCURRENTLY events_id_new_idx ON public.events (id_new);
-- ثم في معاملة قصيرة: إسقاط المفتاح القديم، إعادة التسمية، ADD PRIMARY KEY USING INDEX، نقل الـ sequence
```
```php
// نافذة صيانة لجدول متوسط:
Schema::table('events', function (Blueprint $table) {
    $table->bigInteger('views')->default(0)->change(); // يعيد كتابة الجدول
});
```
- **MySQL:** تغيير النوع على MySQL يستخدم خوارزمية COPY (إعادة بناء تمنع الكتابة) إلا في توسيع `VARCHAR` داخل الفئة نفسها (من أقل من 256 بايت إلى أقل من 256، أو ما فوقها)، فيكون INPLACE فوريًا تقريبًا.
- **References:** https://www.postgresql.org/docs/current/sql-altertable.html · https://www.postgresql.org/docs/current/explicit-locking.html · https://laravel.com/docs/11.x/migrations#modifying-columns

## MS04 · حذف أو إعادة تسمية شيء يستخدمه الكود
- **Severity:** error — تبقى error عندما يكون المرجع في موديل أو Controller أو Service أو مسار؛ اخفضها إلى warning إذا كان المرجع الوحيد نصًا داخل SQL خام (قد يكون اسمًا مشابهًا)؛ وإلى info إذا كان المرجع الوحيد في `$hidden`/`$visible`.
- **Confidence:** high للمراجع البنيوية (موديل بـ `$table` صريح، اسم عمود حرفي في `$fillable`/`$casts`/`where`/مفاتيح العلاقات، `DB::table('name')`)؛ medium عند الربط بالعرف؛ low عند تطابق نصي بحدود كلمة داخل نصوص SQL.
- **Detect:** عمليات `dropTable`, `renameTable`, `dropColumn`, و`updateColumn` حيث `patch.name` يختلف عن `columnName` (إعادة تسمية عمود). حوّل `tableId` إلى اسم الجدول من المخطط، ثم ابحث في الكود المحلَّل خارج `database/migrations`: الموديل المرتبط بالجدول وعلاقات الموديلات الأخرى إليه، `DB::table('<table>')`، أسماء العمود في خصائص الموديل (`$fillable`, `$guarded`, `$casts`/`casts()`, `$dates`, `$appends` إن طابق عمودًا)، الوسيط الأول الحرفي لـ `where*`/`orderBy*`/`select`/`pluck`/`value`/`increment`/`decrement`، مفاتيح العلاقات الحرفية، والنصوص الخام المطابقة لـ `\b<name>\b`.
- **Not a finding when:** المرجع الوحيد في `database/migrations` (تاريخي لا يُنفذ مجددًا)؛ إعادة تسمية جدول إلى اسم العرف لموديل بلا `$table` (يصلح الربط بدل أن يكسره)؛ المرجع في كود ميت مؤكد (صنف لا يستخدمه شيء) فاخفضها إلى warning؛ المسودة تحذف جدولًا جديدًا أضافته بنفسها.
- **Why it matters:** إذا نُفذت المسودة قبل نشر الكود المعدّل، أو بقي الكود القديم يعمل أثناء النشر، تفشل كل استعلامات الجدول أو العمود فورًا بـ `Undefined table`/`Undefined column` (`42P01`/`42703`)، والحذف لا يمكن التراجع عنه بلا نسخة احتياطية.
- **Fix:** اتبع نمط التوسيع ثم التقليص: انشر كودًا لا يستخدم العمود أولًا ثم احذف. لإعادة التسمية: عمود جديد، كتابة مزدوجة، تعبئة، تحويل القراءة، ثم حذف القديم في إصدار لاحق. لإعادة تسمية جدول: أعد التسمية وأنشئ view بالاسم القديم مؤقتًا (الـ view البسيط قابل للكتابة).
```sql
BEGIN;
ALTER TABLE public.customers RENAME TO clients;
CREATE VIEW public.customers AS SELECT * FROM public.clients; -- يُحذف بعد نشر الكود الجديد
COMMIT;
```
```php
// الإصدار 1: أزل العمود من $fillable/$casts وكل الاستعلامات وانشر.
// الإصدار 2: احذف العمود.
Schema::table('orders', function (Blueprint $table) {
    $table->dropColumn('legacy_ref');
});
```
- **MySQL:** لا فرق في MySQL، لكن تذكر أن DDL لا يُتراجع عنه: الحذف أو التسمية نهائيان فور التنفيذ.
- **References:** https://www.postgresql.org/docs/current/sql-createview.html#SQL-CREATEVIEW-UPDATABLE-VIEWS · https://laravel.com/docs/11.x/migrations#dropping-columns · https://www.postgresql.org/docs/current/sql-altertable.html

## MS05 · إنشاء فهرس على جدول كبير دون CONCURRENTLY
- **Severity:** warning — ارفعها إلى error إذا كان الجدول ضخمًا (`≥ 10,000,000`)؛ اخفضها إلى info بين 10,000 و100,000 صف؛ ليست نتيجة تحت 10,000.
- **Confidence:** high عندما `approxRows ≥ 100,000`؛ medium عندما `approxRows` غير معروف.
- **Detect:** عملية `addIndex` حيث `index.concurrently !== true` والجدول (`tableId`) ليس مضافًا في المسودة و`approxRows ≥ 100,000`. لاحظ أيضًا (في الشرح، لا كنتيجة منفصلة): `index.unique === true` (البناء المتزامن يفشل عند وجود قيم مكررة ويترك فهرسًا INVALID)، وفهرس تغطيه بادئة فهرس قائم (انظر IX04).
- **Not a finding when:** `index.concurrently === true`؛ الجدول جديد في المسودة أو صغير (هنا `CONCURRENTLY` غير ضروري، ولا يجوز على جدول أُنشئ في المعاملة نفسها)؛ التنفيذ في نافذة صيانة متوقف فيها التطبيق.
- **Why it matters:** `CREATE INDEX` العادي يأخذ قفل SHARE: القراءة مستمرة لكن كل INSERT وUPDATE وDELETE على الجدول ينتظر حتى ينتهي البناء، وهو دقائق على جدول كبير، فتتعطل الطلبات وتتراكم الاتصالات.
- **Fix:** اضبط `concurrently: true` في عملية `addIndex` للجداول الكبيرة. `CREATE INDEX CONCURRENTLY` لا يعمل داخل كتلة معاملة، فنفّذه وحده خارج أي `BEGIN` (وفي Laravel بـ `public $withinTransaction = false;` في migration مستقلة). إذا فشل البناء يبقى فهرس INVALID يجب حذفه قبل إعادة المحاولة. للفهرس الفريد تحقق من التكرار أولًا.
```sql
SELECT email, count(*) FROM public.users GROUP BY email HAVING count(*) > 1 LIMIT 10;
CREATE UNIQUE INDEX CONCURRENTLY users_email_unique ON public.users (email);
-- عند الفشل:
-- SELECT indexrelid::regclass FROM pg_index WHERE NOT indisvalid;
-- DROP INDEX CONCURRENTLY IF EXISTS public.users_email_unique;
```
```php
return new class extends Migration {
    public $withinTransaction = false;
    public function up(): void {
        DB::statement('CREATE UNIQUE INDEX CONCURRENTLY IF NOT EXISTS users_email_unique ON users (email)');
    }
    public function down(): void {
        DB::statement('DROP INDEX CONCURRENTLY IF EXISTS users_email_unique');
    }
};
```
- **MySQL:** إنشاء فهرس في InnoDB يسمح بالكتابة افتراضيًا (INPLACE منذ 5.6)، فالخطر أقل من PostgreSQL. أضف `ALGORITHM=INPLACE, LOCK=NONE` ليفشل الأمر فورًا بدل أن يقفل الجدول إن تعذر البناء المتزامن.
- **References:** https://www.postgresql.org/docs/current/sql-createindex.html#SQL-CREATEINDEX-CONCURRENTLY · https://www.postgresql.org/docs/current/explicit-locking.html · https://laravel.com/docs/11.x/migrations#creating-indexes

## MS06 · مفتاح أجنبي جديد على جدول كبير يُتحقق منه دفعة واحدة
- **Severity:** warning — ارفعها إلى error إذا كان جدول المصدر ضخمًا (`≥ 10,000,000`) أو كان جدول الهدف كثير الكتابة؛ اخفضها إلى info بين 10,000 و100,000 صف؛ ليست نتيجة تحت 10,000.
- **Confidence:** high عندما `approxRows ≥ 100,000` لجدول المصدر؛ medium عندما `approxRows` غير معروف.
- **Detect:** عملية `addRelation` حيث جدول المصدر (`relation.source`) ليس مضافًا في المسودة و`approxRows ≥ 100,000`. المخطِط يولّد حاليًا `ALTER TABLE … ADD CONSTRAINT … FOREIGN KEY …` عاديًا بلا `NOT VALID`، فكل علاقة على جدول كبير في المسودة نتيجة إلى أن يدعم المخطِط الصيغة ذات الخطوتين.
- **Not a finding when:** جدول المصدر جديد في المسودة أو صغير أو فارغ مؤكدًا؛ القيد يُضاف بـ `NOT VALID` ثم `VALIDATE CONSTRAINT` في خطوة منفصلة؛ التنفيذ في نافذة صيانة متوقف فيها التطبيق.
- **Why it matters:** إضافة مفتاح أجنبي مع التحقق تأخذ قفل SHARE ROW EXCLUSIVE على الجدولين معًا وتمسح جدول المصدر كاملًا، فتتوقف كل الكتابات على الجدولين طوال المسح. وإذا وُجد صف يتيم واحد تفشل العملية بعد كل هذا الانتظار.
- **Fix:** اكشف اليتامى أولًا، ثم أضف القيد `NOT VALID` (قفل لحظي، ويُفحص كل صف جديد من الآن)، ثم `VALIDATE CONSTRAINT` في معاملة أو migration منفصلة (قفل SHARE UPDATE EXCLUSIVE على المصدر وROW SHARE على الهدف، فلا يمنع القراءة والكتابة). تنفيذهما في المعاملة نفسها يبقي القفل الأول طوال التحقق ويلغي الفائدة.
```sql
SELECT count(*) FROM public.orders o LEFT JOIN public.users u ON u.id = o.user_id
WHERE o.user_id IS NOT NULL AND u.id IS NULL;
SET lock_timeout = '3s';
ALTER TABLE public.orders ADD CONSTRAINT orders_user_id_foreign
    FOREIGN KEY (user_id) REFERENCES public.users (id) NOT VALID;
-- خطوة منفصلة:
ALTER TABLE public.orders VALIDATE CONSTRAINT orders_user_id_foreign;
```
```php
// migration 1
DB::statement('ALTER TABLE orders ADD CONSTRAINT orders_user_id_foreign FOREIGN KEY (user_id) REFERENCES users (id) NOT VALID');
// migration 2 (منفصلة)
DB::statement('ALTER TABLE orders VALIDATE CONSTRAINT orders_user_id_foreign');
```
- **MySQL:** إضافة مفتاح أجنبي مع `foreign_key_checks = 1` تستخدم COPY وتمنع الكتابة طوال إعادة البناء؛ مع `foreign_key_checks = 0` تكون INPLACE لكنها لا تتحقق من الصفوف القائمة. للجداول الضخمة استخدم gh-ost أو pt-online-schema-change.
- **References:** https://www.postgresql.org/docs/current/sql-altertable.html · https://www.postgresql.org/docs/current/explicit-locking.html · https://www.postgresql.org/docs/current/ddl-constraints.html#DDL-CONSTRAINTS-FK

## MS07 · عمود جديد بقيمة افتراضية متغيرة يعيد كتابة جدول كبير
- **Severity:** warning — ارفعها إلى error إذا كان الجدول ضخمًا (`≥ 10,000,000`)؛ اخفضها إلى info بين 10,000 و100,000 صف؛ ليست نتيجة تحت 10,000.
- **Confidence:** high عندما تطابق القيمة الافتراضية دالة متغيرة معروفة والجدول كبير؛ medium عندما `approxRows` غير معروف أو كانت القيمة دالة مخصصة لا تُعرف درجة تقلبها.
- **Detect:** عملية `addColumn` على جدول ليس مضافًا في المسودة و`approxRows ≥ 100,000`، و(`column.default` يطابق `(gen_random_uuid|uuid_generate_v[14]|clock_timestamp|timeofday|random|nextval)\s*\(` بلا حساسية لحالة الأحرف، أو النوع `serial`/`bigserial`/`smallserial`، أو عمود identity).
- **Not a finding when:** القيمة الافتراضية ثابتة (`0`, `'web'`, `false`)؛ القيمة `now()` أو `current_timestamp` أو `current_date` أو `transaction_timestamp()` (دوال STABLE تُحسب مرة واحدة عند التنفيذ فلا تعيد الكتابة منذ PostgreSQL 11، وتأخذ كل الصفوف القديمة الوقت نفسه)؛ لا قيمة افتراضية (يتولاها MS01 إن كان NOT NULL)؛ الجدول جديد أو صغير.
- **Why it matters:** منذ PostgreSQL 11 يُضاف العمود ذو القيمة الافتراضية غير المتغيرة بتعديل بيانات وصفية فقط، أما القيمة المتغيرة فيجب حسابها لكل صف، فيعيد PostgreSQL كتابة الجدول كاملًا مع فهارسه تحت قفل ACCESS EXCLUSIVE، ويتوقف التطبيق على الجدول طوال العملية.
- **Fix:** أضف العمود بلا قيمة افتراضية، ثم اضبط القيمة الافتراضية (تسري على الصفوف الجديدة فقط، وهي لحظية)، ثم املأ القديم على دفعات، ثم NOT NULL بالطريقة الآمنة (MS02) إن لزم.
```sql
ALTER TABLE public.orders ADD COLUMN public_id uuid;
ALTER TABLE public.orders ALTER COLUMN public_id SET DEFAULT gen_random_uuid();
UPDATE public.orders SET public_id = gen_random_uuid()
WHERE public_id IS NULL AND id BETWEEN 1 AND 50000; -- كرر بدفعات
```
```php
Schema::table('orders', function (Blueprint $table) {
    $table->uuid('public_id')->nullable(); // لا ->default(DB::raw('gen_random_uuid()')) على جدول كبير
});
DB::statement('ALTER TABLE orders ALTER COLUMN public_id SET DEFAULT gen_random_uuid()');
```
- **MySQL:** إضافة عمود بقيمة افتراضية ثابتة فورية (INSTANT) منذ 8.0.12؛ القيمة التعبيرية مثل `(UUID())` (8.0.13+) تمنع INSTANT وتعيد بناء الجدول.
- **References:** https://www.postgresql.org/docs/current/ddl-alter.html#DDL-ALTER-ADDING-A-COLUMN · https://www.postgresql.org/docs/current/sql-altertable.html · https://www.postgresql.org/docs/current/xfunc-volatility.html
