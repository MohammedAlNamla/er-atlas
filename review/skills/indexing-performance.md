---
id: indexing-performance
title: الفهارس والأداء
version: 1
applies_to: PostgreSQL 12+ · MySQL 8.0+ / MariaDB 10.6+ · Laravel 9–11
---

# الفهارس والأداء

هذا التخصص يحمي زمن الاستجابة مع نمو البيانات: أن تجد الاستعلامات الشائعة وفحوص المفاتيح الأجنبية فهرسًا يخدمها، وألا تُدفع كلفة فهارس مكررة أو غير مستخدمة في كل كتابة. PostgreSQL لا ينشئ فهرسًا على أعمدة المفتاح الأجنبي تلقائيًا، وLaravel لا يفعل ذلك أيضًا على PostgreSQL، فهذه الفجوة هي أكثر مشكلات الأداء شيوعًا في مشاريع Laravel.

## How to judge (AI)
1. "مغطّى بفهرس" يعني أن أعمدة المطلوب تظهر كبادئة (leading prefix) لفهرس btree، بأي ترتيب داخل البادئة. المصادر: `indexes`، أعمدة `primary` مرتبة بـ `number`، `uniqueKeys`، والأعمدة `unique`.
2. القارئ الحالي لا يرى الفهارس الجزئية (`WHERE …`) ولا التعبيرية ولا نوع الفهرس (btree/gin/gist) ولا اسمه. إذا كان الحكم قد يتغير بفهرس من هذا النوع فاخفض الثقة إلى medium واذكر ذلك صراحة.
3. حجم الجدول يحدد الخطورة: كبير `approxRows ≥ 100,000` يرفع الأولوية، صغير `< 10,000` يخفضها إلى info أو يلغيها، لأن المسح الكامل لجدول صغير أرخص غالبًا من الفهرس.
4. الإحصاءات (`pg_stat_user_tables`, `pg_stat_user_indexes`) تراكمية منذ آخر تصفير وخاصة بالخادم الذي قُرئت منه. لا تحكم بأن فهرسًا "غير مستخدم" إذا كان التصفير حديثًا (أقل من 30 يومًا) أو إذا كانت هناك نسخ قراءة (replicas) لا نرى إحصاءاتها.
5. أدلة الكود (where/orderBy) ثابتة لا تعرف التكرار: استعلام في أمر يعمل مرة شهريًا ليس كاستعلام في كل طلب. ارفع الأولوية فقط إذا كان الاستدعاء في Controller أو مسار API أو Service يستدعيه مسار.
6. لا تقترح فهرسًا على عمود منطقي أو عمود حالة قليل القيم وحده؛ اقترح فهرسًا مركبًا يبدأ بالعمود الأكثر انتقائية أو فهرسًا جزئيًا.
7. كل اقتراح لإنشاء أو حذف فهرس على جدول فيه بيانات يجب أن يستخدم `CONCURRENTLY`، ويذكر أن Laravel يغلّف الـ migration في معاملة على PostgreSQL فيلزم `public $withinTransaction = false;`.
8. لا تكرر: FK بلا فهرس يُبلغ عنه IX01 وليس IX02 حتى لو ظهر العمود في `where` في الكود؛ اذكر دليل الكود في شرح IX01 بدلًا من ذلك.
9. لا تقدّر أزمنة بالمللي ثانية ولا نسب تحسن؛ صف الآلية (مسح كامل، قفل، تضخم الكتابة) فقط.

## How to judge on MySQL (AI)
1. InnoDB ينشئ فهرسًا تلقائيًا على أعمدة المفتاح الأجنبي إن لم يجد فهرسًا يبدأ بها، فالمفتاح الأجنبي بلا فهرس نادر في قاعدة حية ويظهر غالبًا في المسودة أو في جداول MyISAM.
2. كل فهرس ثانوي في InnoDB يحمل أعمدة المفتاح الأساسي ضمنيًا في آخره: الفهرس `(a)` يعمل كـ `(a, id)`.
3. لا فهارس جزئية في MySQL؛ البديل عمود مولّد (generated column) مفهرس أو فهرس مركب. الفهارس الوظيفية متاحة من 8.0.13.
4. إحصاءات الاستخدام من `performance_schema` وتبدأ من آخر تشغيل للخادم؛ إن كان معطلًا فالقارئ لا يعرف الاستخدام (scans = null) فلا تحكم بأن فهرسًا غير مستخدم.
5. بدل `CONCURRENTLY` يستخدم MySQL الـ online DDL: `ALGORITHM=INPLACE, LOCK=NONE` يبني الفهرس مع السماح بالكتابة، مع قفل metadata قصير في البداية والنهاية.

## IX01 · مفتاح أجنبي بلا فهرس
- **Severity:** warning — ارفعها إلى error إذا كان جدول المصدر كبيرًا والعلاقة `ON DELETE CASCADE` أو `SET NULL` (`onDelete` = `c` أو `n`)؛ اخفضها إلى info إذا كان جدول المصدر صغيرًا (`approxRows < 10,000`).
- **Confidence:** high عندما لا يغطي أي فهرس أو مفتاح أعمدة العلاقة؛ medium إذا كان `approxRows` صفرًا أو غير معروف، أو إذا احتمل وجود فهرس جزئي/تعبيري لا يقرؤه القارئ.
- **Detect:** لكل `relation` اجمع `wanted = set(pairs.map(p => p.source))`. المفاتيح المرشحة على جدول المصدر: كل عنصر في `indexes`، والمفتاح الأساسي (أعمدة `primary` مرتبة بـ `number`)، وكل `uniqueKeys`، و`[c.name]` لكل عمود `unique`. العلاقة مغطاة إذا وُجد مفتاح طوله ≥ `wanted.size` وأول `wanted.size` من أعمدته كلها في `wanted`. وإلا فهي نتيجة. (هذا يطابق `fk-without-index` في `public/lint.js`.)
- **Not a finding when:** الأعمدة بادئة لفهرس مركب (`(user_id, created_at)` يغطي `user_id`)، أو بادئة للمفتاح الأساسي المركب في جدول وسيط (`PRIMARY KEY (role_id, user_id)` يغطي `role_id` فقط؛ يبقى `user_id` نتيجة)؛ علاقة ذاتية على المفتاح الأساسي نفسه؛ جدول المصدر صغير جدًا (`approxRows < 1,000`) وجدول الهدف جدول مرجعي نادر الحذف (`countries`, `currencies`) فاخفضها إلى info بدل إلغائها.
- **Why it matters:** كل حذف أو تعديل لمفتاح في جدول الهدف يجعل PostgreSQL يبحث في جدول المصدر عن الصفوف المرتبطة؛ بلا فهرس يكون ذلك مسحًا كاملًا لكل صف محذوف، مع قفل أطول، ويصبح الحذف المتسلسل (CASCADE) بطيئًا جدًا. وكل علاقة `hasMany` في Eloquent (`$user->orders`) تمسح الجدول كاملًا.
- **Fix:** أنشئ فهرسًا على أعمدة المفتاح بالترتيب الأكثر استخدامًا في الاستعلامات، بشكل متزامن.
```sql
CREATE INDEX CONCURRENTLY IF NOT EXISTS orders_user_id_index ON public.orders (user_id);
```
```php
return new class extends Migration {
    public $withinTransaction = false; // CONCURRENTLY لا يعمل داخل معاملة
    public function up(): void {
        DB::statement('CREATE INDEX CONCURRENTLY IF NOT EXISTS orders_user_id_index ON orders (user_id)');
    }
};
// لجدول جديد أو صغير يكفي: $table->foreignId('user_id')->index()->constrained();
```
- **MySQL:** InnoDB ينشئ الفهرس تلقائيًا عند إضافة المفتاح الأجنبي إن لم يجد فهرسًا مناسبًا، فالنتيجة في قاعدة حية تعني غالبًا جدول MyISAM أو قيدًا في المسودة. الإصلاح: `ALTER TABLE orders ADD INDEX orders_user_id_index (user_id), ALGORITHM=INPLACE, LOCK=NONE;`
- **References:** https://www.postgresql.org/docs/current/ddl-constraints.html#DDL-CONSTRAINTS-FK · https://www.postgresql.org/docs/current/sql-createindex.html#SQL-CREATEINDEX-CONCURRENTLY · https://laravel.com/docs/11.x/migrations#creating-indexes

## IX02 · عمود يُبحث أو يُرتَّب به في الكود بلا فهرس
- **Severity:** warning — اخفضها إلى info إذا كان الجدول صغيرًا أو كان الاستدعاء في أمر/Job دوري لا في مسار طلب؛ لا ترفعها إلى error لأن الكود الثابت لا يثبت التكرار.
- **Confidence:** high عندما يكون اسم العمود نصًا حرفيًا والجدول محسومًا من الموديل والجدول كبير؛ medium عندما يُستنتج الجدول من سلسلة استدعاءات عبر دوال أو scopes؛ low عندما يكون `approxRows` غير معروف.
- **Detect:** من استدعاءات Query Builder/Eloquent على موديل معروف الجدول: `where`, `orWhere`, `whereIn`, `whereBetween`, `firstWhere`, `orderBy`, `orderByDesc`, `latest`, `oldest` (العمود الافتراضي `created_at`)، و`where{Column}` الديناميكية (`whereEmail` ← `email`)؛ حيث الوسيط الأول نص حرفي يطابق `^[a-z_][a-z0-9_]*$` (أو `table.column`) وعمود موجود في الجدول. النتيجة إذا لم يكن العمود أول عمود في أي مفتاح مرشح (كما في IX01) والجدول ليس صغيرًا. إذا ظهر عدة أعمدة `where` في السلسلة نفسها فاقترح فهرسًا مركبًا بترتيب المساواة أولًا ثم المدى/الترتيب.
- **Not a finding when:** العمود مغطى كعمود أول في فهرس أو مفتاح؛ العمود مفتاح أجنبي (يتولاه IX01)؛ الاستدعاء على Collection بعد `get()`/`all()` (مثل `$items->where('status', 1)` يعمل في الذاكرة)؛ اسم العمود متغير أو من الطلب (لا يمكن تحديده ثابتًا)؛ عمود منطقي أو قليل القيم وحده (`is_active`, `status`) في سلسلة فيها شرط مساواة على عمود مفهرس أكثر انتقائية؛ `where('name', 'like', '%…')` بنمط يبدأ بـ `%` (فهرس btree لا يساعد؛ اقترح `pg_trgm` بدلًا من ذلك)؛ `whereDate`/`whereMonth`/`whereYear` التي يحوّل Laravel فيها العمود (`"created_at"::date`) فلا يخدمها فهرس عادي (اقترح شرط مدى بدل الفهرس)؛ الجدول صغير.
- **Why it matters:** استعلام يتكرر في كل طلب على جدول كبير بلا فهرس مناسب يقرأ الجدول كله ويرتبه في الذاكرة أو على القرص، فيرتفع زمن الاستجابة وحمل القاعدة خطيًا مع نمو البيانات، ويظهر ذلك فجأة بعد أشهر من الإطلاق.
- **Fix:** أنشئ الفهرس الذي يطابق شكل الاستعلام فعليًا، وتحقق بـ `EXPLAIN (ANALYZE, BUFFERS)` على نسخة من البيانات.
```sql
-- where('store_id', $id)->where('status', 'paid')->orderByDesc('created_at')
CREATE INDEX CONCURRENTLY orders_store_status_created_index
    ON public.orders (store_id, status, created_at DESC);
```
```php
public $withinTransaction = false;
public function up(): void {
    DB::statement('CREATE INDEX CONCURRENTLY orders_store_status_created_index ON orders (store_id, status, created_at DESC)');
}
```
- **MySQL:** لـ `LIKE '%…'` استخدم فهرس `FULLTEXT` مع `MATCH … AGAINST` بدل pg_trgm. ولـ `whereDate` أنشئ عمودًا مولّدًا مفهرسًا (`created_date DATE AS (DATE(created_at)) STORED`) أو حوّل الشرط إلى مدى.
- **References:** https://www.postgresql.org/docs/current/indexes-multicolumn.html · https://www.postgresql.org/docs/current/indexes-ordering.html · https://www.postgresql.org/docs/current/using-explain.html

## IX03 · SoftDeletes بلا فهرس يخدم deleted_at
- **Severity:** info — ارفعها إلى warning فقط إذا كان الجدول كبيرًا ونسبة المحذوف كبيرة (`pg_stats.null_frac` لعمود `deleted_at` أقل من 0.8، أي أكثر من 20% محذوف).
- **Confidence:** medium افتراضيًا لأن القارئ لا يرى الفهارس الجزئية؛ high فقط إذا قُرئت الفهارس الجزئية وتأكد غياب أي فهرس بشرط `deleted_at IS NULL`؛ low إذا لم تتوفر `null_frac`.
- **Detect:** موديل يستخدم trait `SoftDeletes` (أو `Illuminate\Database\Eloquent\SoftDeletes`) ويشير إلى جدول فيه عمود `deleted_at` (أو الاسم في `const DELETED_AT`)، والجدول ليس صغيرًا، ولا يحتوي أي عنصر في `indexes` على `deleted_at`، ولا يوجد فهرس جزئي معروف بشرط `deleted_at IS NULL`.
- **Not a finding when:** الجدول صغير؛ نسبة المحذوف صغيرة (`null_frac ≥ 0.9`)، فشرط `deleted_at IS NULL` غير انتقائي ولن يستعمل الفهرس أصلًا؛ الاستعلامات الشائعة تمر بفهرس انتقائي على عمود آخر (مثل `user_id`) فيكفي ذلك؛ الموديل يستخدم `withTrashed()` في معظم الاستعلامات.
- **Why it matters:** `SoftDeletes` يضيف `where "table"."deleted_at" is null` إلى كل استعلام Eloquent. عندما تتراكم الصفوف المحذوفة منطقيًا، تقرأ الاستعلامات وتتجاهل عددًا متزايدًا من الصفوف الميتة، وتكبر الفهارس العادية بصفوف لا يطلبها أحد.
- **Fix:** الأفضل عادة فهرس جزئي على الأعمدة التي يُبحث بها فعلًا، مقيد بالصفوف الحية، لا فهرس مفرد على `deleted_at`.
```sql
CREATE INDEX CONCURRENTLY orders_user_id_active_index
    ON public.orders (user_id) WHERE deleted_at IS NULL;
```
```php
public $withinTransaction = false;
public function up(): void {
    DB::statement('CREATE INDEX CONCURRENTLY orders_user_id_active_index ON orders (user_id) WHERE deleted_at IS NULL');
}
```
- **MySQL:** لا فهارس جزئية في MySQL: استخدم فهرسًا مركبًا يبدأ بالعمود الانتقائي وينتهي بـ `deleted_at` (مثل `(user_id, deleted_at)`)، أو عمودًا مولّدًا مفهرسًا.
- **References:** https://www.postgresql.org/docs/current/indexes-partial.html · https://laravel.com/docs/11.x/eloquent#soft-deleting

## IX04 · فهرس مكرر يغطيه فهرس آخر
- **Severity:** info — ارفعها إلى warning إذا كان الجدول كبيرًا وكثير الكتابة (`n_tup_ins + n_tup_upd` مرتفع في الإحصاءات) لأن كل فهرس زائد يبطئ كل كتابة.
- **Confidence:** high عند التطابق التام لأعمدة فهرسين عاديين؛ medium عندما يكون المكرر بادئة لفهرس أطول (قد يكون الأقصر أصغر وأسرع لبعض الاستعلامات، أو من نوع مختلف لا يراه القارئ).
- **Detect:** على كل جدول، ابنِ قائمة الفهارس من `indexes`. الفهرس A مكرر إذا وُجد فهرس B مختلف بحيث `A.length ≤ B.length` و`A` تساوي أول `A.length` من أعمدة `B` **بالترتيب نفسه**. القارئ يدرج فهارس المفتاح الأساسي والفريدة ضمن `indexes`، فحدد الفهرس الذي يدعم قيدًا بمطابقته مع أعمدة `primary` أو `uniqueKeys` أو الأعمدة `unique`: هذا لا يُبلغ عنه أبدًا كمكرر؛ إذا تطابق فهرسان تمامًا فالمُبلغ عنه هو الذي لا يدعم قيدًا.
- **Not a finding when:** A يدعم مفتاحًا أساسيًا أو قيدًا فريدًا (الفهرس الفريد يفرض قيدًا ولا يغني عنه فهرس غير فريد أطول)؛ الترتيب مختلف (`(a, b)` و`(b, a)` يخدمان استعلامات مختلفة)؛ اختلاف نوع الفهرس أو الشرط الجزئي أو الـ opclass (مثل btree مقابل gin، أو `text_pattern_ops`) عندما تتوفر هذه المعلومة؛ الفهرس الأطول يحتوي أعمدة `INCLUDE` فقط زائدة (القارئ يقطعها أصلًا عند `indnkeyatts`).
- **Why it matters:** كل فهرس يُحدَّث مع كل INSERT وكل UPDATE يغيّر أعمدته (ويمنع تحديثات HOT)، ويشغل ذاكرة التخزين المؤقت ومساحة القرص ووقت VACUUM، دون أن يخدم استعلامًا لا يخدمه الفهرس الآخر.
- **Fix:** تحقق من `pg_stat_user_indexes.idx_scan` للفهرسين، ثم احذف المكرر بشكل متزامن.
```sql
DROP INDEX CONCURRENTLY IF EXISTS public.orders_user_id_index; -- يغطيه orders_user_id_created_at_index
```
```php
public $withinTransaction = false;
public function up(): void {
    DB::statement('DROP INDEX CONCURRENTLY IF EXISTS orders_user_id_index');
}
```
- **MySQL:** لأن الفهرس الثانوي يحمل المفتاح الأساسي ضمنيًا، فـ `(a, id)` مكرر لـ `(a)`. العرض `sys.schema_redundant_indexes` يسرد التكرارات. انتبه: إن كان الأقصر هو فهرس مفتاح أجنبي فـ InnoDB يرفض حذفه (خطأ 1553) ما لم يبدأ الأطول بأعمدة المفتاح. الحذف: `ALTER TABLE t DROP INDEX name;`
- **References:** https://www.postgresql.org/docs/current/indexes-multicolumn.html · https://www.postgresql.org/docs/current/sql-dropindex.html

## IX05 · فهرس لم يُستخدم منذ آخر تصفير للإحصاءات
- **Severity:** info — ارفعها إلى warning إذا كان الجدول كبيرًا وحجم الفهرس كبيرًا والتصفير أقدم من 90 يومًا؛ لا ترفعها أكثر لأن الحذف الخاطئ يسبب انهيار أداء.
- **Confidence:** high عندما يكون `stats_reset` أقدم من 30 يومًا ولا توجد نسخ قراءة؛ medium إذا كان تاريخ التصفير غير معروف؛ low إذا كان التصفير أحدث من 7 أيام أو الفهرس أُنشئ حديثًا.
- **Detect:** من `pg_stat_user_indexes` (مربوطًا بـ `pg_index`): `idx_scan = 0`، والفهرس ليس `indisunique` ولا `indisprimary` ولا يدعم قيد exclusion، والجدول ليس صغيرًا. سجّل `pg_relation_size(indexrelid)` و`pg_stat_database.stats_reset`، وفي PostgreSQL 16+ `last_idx_scan`. يحتاج قراءة اسم الفهرس وهو غير متوفر في `indexes` الحالي.
- **Not a finding when:** الفهرس فريد أو مفتاح أساسي (يفرض قيدًا حتى لو لم يُقرأ)؛ الفهرس يغطي مفتاحًا أجنبيًا (يُستخدم عند حذف صفوف الهدف، وقد لا يحدث ذلك في فترة القياس، وحذفه يعيد مشكلة IX01)؛ الإحصاءات صُفّرت حديثًا؛ القاعدة لها نسخ قراءة (الإحصاءات محلية لكل خادم، والفهرس قد يُستخدم هناك)؛ الفهرس يخدم تقارير دورية (شهرية/سنوية)؛ الجدول صغير.
- **Why it matters:** الفهرس غير المستخدم يدفع كلفة كاملة في كل كتابة وفي VACUUM والنسخ الاحتياطي دون أي فائدة قراءة. لكن الحكم مبني على نافذة قياس، فالخطأ في الحذف أسوأ من الإبقاء.
- **Fix:** تحقق أولًا على كل الخوادم وفي نافذة تغطي الدورات الشهرية، ثم احذف بشكل متزامن واحتفظ بتعريفه لإعادته عند الحاجة.
```sql
SELECT s.relname, s.indexrelname, s.idx_scan, pg_size_pretty(pg_relation_size(s.indexrelid)) AS size,
       pg_get_indexdef(s.indexrelid) AS definition
FROM pg_stat_user_indexes s JOIN pg_index i ON i.indexrelid = s.indexrelid
WHERE s.idx_scan = 0 AND NOT i.indisunique AND NOT i.indisprimary;
DROP INDEX CONCURRENTLY IF EXISTS public.orders_legacy_ref_index;
```
```php
public $withinTransaction = false;
public function up(): void { DB::statement('DROP INDEX CONCURRENTLY IF EXISTS orders_legacy_ref_index'); }
public function down(): void { DB::statement('CREATE INDEX CONCURRENTLY orders_legacy_ref_index ON orders (legacy_ref)'); }
```
- **MySQL:** العداد من `performance_schema` ويُصفّر عند كل إعادة تشغيل للخادم؛ `sys.schema_unused_indexes` يسرد غير المستخدم. قبل الحذف اجعل الفهرس غير مرئي واختبر: `ALTER TABLE t ALTER INDEX name INVISIBLE;` ثم أرجعه بـ `VISIBLE` إن احتجته.
- **References:** https://www.postgresql.org/docs/current/monitoring-stats.html#MONITORING-PG-STAT-ALL-INDEXES-VIEW · https://www.postgresql.org/docs/current/sql-dropindex.html

## IX06 · جدول كبير يُقرأ بمسح كامل أكثر من الفهارس
- **Severity:** warning — ارفعها إلى error إذا كان الجدول ضخمًا (`≥ 10,000,000`) ومتوسط الصفوف المقروءة لكل مسح (`seq_tup_read / seq_scan`) قريبًا من حجم الجدول ويتكرر المسح؛ اخفضها إلى info للجداول التحليلية أو التي تُقرأ كاملة بطبيعتها.
- **Confidence:** medium افتراضيًا لأن الإحصاءات لا تقول أي استعلام سبب المسح؛ high إذا دعم ذلك دليل من الكود (IX02/IX01 على الجدول نفسه)؛ low إذا كانت الإحصاءات حديثة التصفير.
- **Detect:** من `pg_stat_user_tables`: `n_live_tup ≥ 100,000` و`seq_scan > COALESCE(idx_scan, 0)` و`seq_scan ≥ 100` (نشاط كافٍ) و`seq_tup_read / NULLIF(seq_scan, 0) ≥ 10,000` (المسح يقرأ عددًا كبيرًا من الصفوف فعلًا).
- **Not a finding when:** الجدول صغير (المخطِط يفضّل المسح الكامل بحق)؛ جداول التقارير أو التصدير التي تُقرأ كاملة بالتصميم؛ المسوحات ناتجة عن `pg_dump` أو أدوات نسخ أو مزامنة تقرأ الجدول كاملًا (كل `pg_dump` يزيد `seq_scan`)؛ الإحصاءات صُفّرت حديثًا؛ الجدول جديد ولم يُحلَّل بعد (`last_analyze` و`last_autoanalyze` فارغان).
- **Why it matters:** مسح جدول كبير في مسار طلب يقرأ كل صفحاته في كل مرة، فيطرد البيانات المفيدة من الذاكرة ويرفع زمن الاستجابة لكل المستخدمين لا لهذا الاستعلام وحده. غالبًا السبب فهرس ناقص على عمود ربط أو تصفية، أو استعلام يمنع استخدام الفهرس (دالة على العمود، `LIKE '%…'`، تحويل نوع).
- **Fix:** حدد الاستعلامات المسؤولة أولًا (`pg_stat_statements` إن كان مفعلًا) ثم أضف الفهرس المناسب (IX01/IX02) أو أعد كتابة الشرط ليستخدم الفهرس.
```sql
SELECT relname, n_live_tup, seq_scan, seq_tup_read, idx_scan,
       seq_tup_read / NULLIF(seq_scan, 0) AS avg_rows_per_seq_scan
FROM pg_stat_user_tables WHERE n_live_tup >= 100000 ORDER BY seq_tup_read DESC LIMIT 20;
```
```php
// بدل whereDate('created_at', $day) الذي يولّد "created_at"::date = ? ويمنع الفهرس:
$start = $day->copy()->startOfDay();
Order::where('created_at', '>=', $start)->where('created_at', '<', $start->copy()->addDay());
```
- **MySQL:** القارئ لا يوفر عدد المسوحات الكاملة على MySQL، فهذا الفحص لا يعمل عليها تلقائيًا. افحصه يدويًا بـ `sys.schema_tables_with_full_table_scans` و`sys.statements_with_full_table_scans`.
- **References:** https://www.postgresql.org/docs/current/monitoring-stats.html#MONITORING-PG-STAT-ALL-TABLES-VIEW · https://www.postgresql.org/docs/current/pgstatstatements.html · https://www.postgresql.org/docs/current/using-explain.html
