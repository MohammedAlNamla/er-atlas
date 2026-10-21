---
id: laravel-security
title: أمان البيانات في Laravel
version: 1
applies_to: PostgreSQL 12+ · Laravel 9–11
---

# أمان البيانات في Laravel

هذا التخصص يحمي البيانات من أن تُقرأ أو تُعدَّل بطريقة لم يقصدها الفريق: حقن SQL عبر الاستعلامات الخام، والإسناد الجماعي الذي يسمح للمستخدم بتغيير صلاحياته، والأسرار المخزنة نصًا صريحًا، والأعمدة الحساسة التي تتسرب في ردود JSON. هذه الثغرات تُستغل من الخارج مباشرة، وأثرها تسريب بيانات أو تصعيد صلاحيات لا يمكن التراجع عنه بعد حدوثه.

## How to judge (AI)
1. الدليل المقبول: ملف وسطر من الكود المحلَّل (`file:line`) مع شكل الوسيط (نص حرفي، نص فيه متغير `"…{$x}…"`، دمج بـ `.`، مصفوفة bindings)، وخصائص الموديل (`$fillable`, `$guarded`, `$hidden`, `$visible`, `$casts` أو دالة `casts()` في Laravel 11)، واسم العمود ونوعه من المخطط.
2. لا تدّعِ أن قيمة "تأتي من المستخدم" إلا إذا ظهر مصدرها في السطر نفسه أو الدالة نفسها (`$request->…`, `request()`, `Input::`, معامل route). إذا جاء المتغير من دالة أخرى أو خاصية فاخفض الثقة إلى medium.
3. الحقن (SEC01) الذي يصل إليه مدخل المستخدم يتقدم على كل شيء؛ ثم الإسناد الجماعي المفتوح مع تمرير الطلب كاملًا (SEC02)؛ ثم الأسرار غير المجزأة (SEC03)؛ ثم التسريب في JSON (SEC04)؛ ثم البيانات الشخصية (SEC05).
4. اخفض الخطورة درجة إذا كان المسار داخليًا مؤكدًا (أمر Artisan، Seeder، Job بلا مدخل خارجي)؛ لا تخفضها لمجرد أن المسار "لوحة إدارة" فهي هدف شائع أيضًا.
5. التحليل ثابت: لا يرى قيم وقت التشغيل، ولا أسماء الأعمدة الديناميكية، ولا الاستعلامات المبنية عبر عدة دوال، ولا Form Requests التي تتحقق من المدخل. اذكر هذا القيد كلما خفضت الثقة لأجله.
6. لا تعتبر `$request->validated()` أو `$request->safe()->only([...])` أو `$request->only([...])` بقائمة حرفية تمريرًا للطلب كاملًا.
7. لا تطلب تشفير أعمدة يجب البحث فيها أو ربطها دون أن تذكر الكلفة (لا فهرسة ولا بحث على عمود `encrypted`؛ يلزم عمود hash منفصل للبحث).
8. لا تقترح أبدًا تخزين كلمات المرور بتشفير قابل للعكس؛ كلمات المرور تُجزأ (`Hash::make` أو cast `hashed`)، والأسرار التي يلزم استرجاعها تُشفّر (cast `encrypted`).
9. لا تكشف قيمًا حقيقية في الشرح؛ اذكر الأعمدة والملفات فقط.

## SEC01 · استعلام SQL خام يدمج متغيرات في النص
- **Severity:** error — تبقى error عندما يصل مدخل المستخدم إلى النص الخام؛ warning عندما يكون المتغير غير معروف المصدر أو اسم عمود يُمرر إلى `orderBy`/`where` كمعرّف (لا كقيمة)؛ info في الأوامر والـ Seeders بلا مدخل خارجي.
- **Confidence:** high عندما يظهر `$request`/`request()` أو معامل route في النص المدمج في الدالة نفسها؛ medium عندما يأتي المتغير من معامل دالة أو خاصية؛ low عندما يكون المتغير محوّلًا (`(int)`, `intval`) أو مأخوذًا من قائمة بيضاء (`in_array`, `match`) لم يتأكد المحلل من شمولها.
- **Detect:** استدعاءات `whereRaw`, `orWhereRaw`, `havingRaw`, `orHavingRaw`, `orderByRaw`, `groupByRaw`, `selectRaw`, `fromRaw`, `DB::raw`, `DB::select`, `DB::selectOne`, `DB::insert`, `DB::update`, `DB::delete`, `DB::statement`, `DB::unprepared` حيث الوسيط الأول ليس نصًا حرفيًا خالصًا: نص بمتغيرات مضمّنة (encapsed `"… $x …"` أو `"{$x}"`)، أو دمج `.` مع عنصر غير حرفي، أو `sprintf`/`implode` بمتغير. `DB::unprepared` بأي متغير = high دائمًا. الشكل الثاني: `orderBy`, `orderByDesc`, `where`, `groupBy`, `select` حيث اسم العمود (الوسيط الأول) من الطلب مباشرة (`$request->input('sort')`, `$request->sort`).
- **Not a finding when:** النص حرفي مع علامات `?` أو `:name` والقيم في مصفوفة الـ bindings (`whereRaw('price > ?', [$min])`)؛ الدمج مع ثوابت أو ثوابت صنف فقط (`self::TABLE`, `static::COLUMN`)؛ المتغير اسم جدول/عمود من ثابت داخلي أو `$this->getTable()`/`$model->getKeyName()`؛ `orderBy` باسم عمود حرفي واتجاه من الطلب (Laravel يرفض اتجاهًا غير `asc`/`desc`)؛ الكود في `database/migrations` أو `database/seeders`.
- **Why it matters:** دمج المدخل في نص SQL يسمح للمهاجم بتغيير الاستعلام: قراءة جداول أخرى (UNION)، أو تجاوز الشروط، أو التعديل والحذف. أما اسم العمود من الطلب فيقتبسه Laravel كمعرّف فلا يُحقن عادة، لكنه يسمح بالترتيب أو التصفية بأي عمود، بما فيه أعمدة مخفية مثل `password`، فيُستنتج محتواها من ترتيب النتائج.
- **Fix:** مرّر القيم كـ bindings دائمًا، وقيّد أسماء الأعمدة بقائمة بيضاء حرفية.
```sql
-- خطأ: ... WHERE name = '<user input>'
-- صحيح: معامل مربوط
SELECT * FROM products WHERE name = $1;
```
```php
// خطأ:
Product::whereRaw("name = '{$request->name}'")->get();
// صحيح:
Product::whereRaw('name = ?', [$request->input('name')])->get();
// أسماء الأعمدة: قائمة بيضاء
$sort = in_array($request->input('sort'), ['name', 'price', 'created_at'], true) ? $request->input('sort') : 'created_at';
Product::orderBy($sort, $request->input('dir') === 'asc' ? 'asc' : 'desc')->get();
```
- **References:** https://laravel.com/docs/11.x/queries#raw-expressions · https://cheatsheetseries.owasp.org/cheatsheets/SQL_Injection_Prevention_Cheat_Sheet.html · https://cheatsheetseries.owasp.org/cheatsheets/Laravel_Cheat_Sheet.html

## SEC02 · إسناد جماعي مفتوح أو يشمل أعمدة صلاحيات
- **Severity:** warning — ارفعها إلى error إذا وُجد في الكود تمرير الطلب كاملًا (`$request->all()`, `$request->input()` بلا وسيط، `$request->except([...])`, `request()->all()`) إلى `create`, `fill`, `update`, `forceFill`, `firstOrCreate`, `updateOrCreate` على هذا الموديل؛ اخفضها إلى info إذا كانت كل عمليات الكتابة تمر بـ `validated()` أو `only([...])`.
- **Confidence:** high عند `$guarded = []` أو `Model::unguard()` مع تمرير الطلب كاملًا؛ medium عند `$guarded = []` بلا دليل على مسار الكتابة؛ medium لعمود صلاحيات في `$fillable`؛ low إذا لم يُعثر على أي كتابة جماعية للموديل.
- **Detect:** (1) موديل فيه `protected $guarded = [];` أو `$guarded = []` بلا `$fillable`؛ (2) استدعاء `Model::unguard()` أو `Model::unguarded(` في أي ملف خارج `database/seeders`؛ (3) `$fillable` يحتوي عمودًا يطابق `^(is_admin|admin|is_super_?admin|role|role_id|roles|permissions|is_staff|is_verified|verified_at|email_verified_at|approved|is_approved|approved_at|balance|wallet_balance|credits?|points|tenant_id|team_id|owner_id|store_id|account_id|plan|plan_id|subscription_status)$`. اربط النتيجة بأماكن `Model::create($request->all())` وما يشبهها إن وُجدت.
- **Not a finding when:** `$guarded = ['*']` (القيمة الافتراضية، كل شيء محمي)؛ `$fillable` الافتراضي لموديل `User` (`name`, `email`, `password`)؛ كلمة المرور في `$fillable` ليست عمود صلاحيات؛ عمود الملكية (`store_id`, `tenant_id`) يُضبط دائمًا من المستخدم المصادق (`auth()->user()->store_id`) والطلب يمر بـ `validated()`؛ `unguard()` داخل Seeder أو اختبار.
- **Why it matters:** `$guarded = []` يعطل حماية الإسناد الجماعي: إذا وصل `$request->all()` إلى `create`/`update` يستطيع المستخدم إرسال `is_admin=1` أو `role=admin` أو `balance=99999` أو `store_id` لمتجر آخر فيُكتب كما هو. هذه ثغرة تصعيد صلاحيات مباشرة.
- **Fix:** حدّد `$fillable` صراحة بالأعمدة التي يحررها المستخدم، وأخرج أعمدة الصلاحيات والملكية منها، واكتبها بإسناد صريح، ومرّر `validated()` فقط.
```sql
-- لا تغيير في القاعدة؛ للتحقق من عدم وجود تصعيد سابق:
SELECT id, email, is_admin, updated_at FROM users WHERE is_admin ORDER BY updated_at DESC;
```
```php
class User extends Authenticatable {
    protected $fillable = ['name', 'email', 'password'];
}
$user = User::create($request->validated());
$user->is_admin = $request->user()->can('promote') && $request->boolean('is_admin');
$user->save();
```
- **References:** https://laravel.com/docs/11.x/eloquent#mass-assignment · https://cheatsheetseries.owasp.org/cheatsheets/Mass_Assignment_Cheat_Sheet.html · https://laravel.com/docs/11.x/validation#working-with-validated-input

## SEC03 · سر أو رمز مخزّن دون تشفير أو تجزئة ظاهرة
- **Severity:** warning — ارفعها إلى error لأعمدة كلمات المرور (`password`, `passwd`, `*_password`) أو مفاتيح API طرف ثالث (`*_secret`, `api_key`, `private_key`) بلا أي دليل تجزئة أو تشفير؛ اخفضها إلى info للرموز قصيرة العمر (`otp`, `verification_code`) مع عمود انتهاء.
- **Confidence:** high عندما لا يحمل الموديل cast `hashed` أو `encrypted*` للعمود ولا يوجد في المشروع `Hash::make`/`bcrypt(`/`Crypt::encrypt`/`encrypt(` أو mutator للعمود؛ medium عندما توجد تجزئة في مكان ما من المشروع لا يمكن ربطها بالعمود ثابتًا؛ low عندما لا يوجد موديل للجدول.
- **Detect:** أعمدة نوعها `text`/`varchar`/`char` واسمها يطابق `(^|_)(password|passwd|secret|token|api_key|apikey|access_key|secret_key|private_key|client_secret|access_token|refresh_token|otp|pin_code|recovery_codes?)($|_)`، والموديل المرتبط لا يحتوي العمود في `$casts`/`casts()` بقيمة `hashed`, `encrypted`, `encrypted:array`, `encrypted:collection`, `encrypted:object`, `AsEncryptedArrayObject`, `AsEncryptedCollection`، ولا يوجد mutator (`setXAttribute` أو `Attribute::make(set: …)`) يستدعي `Hash::make`/`bcrypt`/`Crypt::encryptString`.
- **Not a finding when:** الاسم ينتهي بـ `_at`, `_type`, `_id`, `_count`, `_expires_at`, `_hint`, `_length` أو النوع `boolean`/`timestamp`/رقمي (بيانات وصفية لا سر)؛ `users.remember_token` (رمز عشوائي يديره Laravel)؛ `personal_access_tokens.token` (Sanctum يخزن SHA-256)؛ `password_reset_tokens.token`/`password_resets.token` (Laravel يجزئه)؛ `two_factor_secret`/`two_factor_recovery_codes` مع حزمة `laravel/fortify` (تشفّرها بـ `encrypt()`)؛ جداول `oauth_*` لـ Passport؛ `sessions.payload`؛ عمود `bytea` أو اسمه ينتهي بـ `_hash`/`_digest`/`_encrypted`؛ `password` مُجزأ في `User` عبر `Hash::make` في Actions/Controllers (الشكل الافتراضي قبل Laravel 10).
- **Why it matters:** أي تسريب للقاعدة (نسخة احتياطية، حقن SQL، صلاحية قراءة زائدة، سجل خطأ) يكشف هذه القيم صالحة للاستخدام فورًا: دخول بحسابات المستخدمين، واستدعاء واجهات الطرف الثالث بمفاتيحكم. كلمات المرور تحديدًا يعيد المستخدمون استخدامها في خدمات أخرى.
- **Fix:** كلمات المرور تُجزأ (cast `hashed` في Laravel 10+ أو `Hash::make`)، والأسرار التي يلزم استرجاعها تُشفّر بـ cast `encrypted` (يحتاج عمود `text` لأن الناتج أطول). نفّذ ترحيلًا يجزئ/يشفّر القيم الموجودة على دفعات، ثم دوّر المفاتيح المكشوفة.
```sql
-- cast encrypted يحتاج نصًا طويلًا
ALTER TABLE public.integrations ALTER COLUMN api_key TYPE text;
```
```php
protected function casts(): array {
    return ['password' => 'hashed', 'api_key' => 'encrypted'];
}
// ترحيل القيم القديمة:
Integration::query()->chunkById(500, function ($rows) {
    foreach ($rows as $row) {
        $plain = $row->getRawOriginal('api_key');
        DB::table('integrations')->where('id', $row->id)->update(['api_key' => Crypt::encryptString($plain)]);
    }
});
```
- **References:** https://laravel.com/docs/11.x/eloquent-mutators#encrypted-casting · https://laravel.com/docs/11.x/hashing · https://cheatsheetseries.owasp.org/cheatsheets/Password_Storage_Cheat_Sheet.html

## SEC04 · عمود حساس غير مخفي عند تحويل الموديل إلى JSON
- **Severity:** warning — ارفعها إلى error لكلمات المرور ورموز الوصول إذا كان الموديل يُرجع مباشرة من Controller أو مسار API (`return $user;`, `response()->json($user)`)؛ اخفضها إلى info إذا كان الموديل يُعرض دائمًا عبر API Resource يحدد الحقول صراحة.
- **Confidence:** high عندما لا يوجد العمود في `$hidden` ولا يوجد `$visible` والموديل يُرجع مباشرة في Controller؛ medium بلا دليل على مسار الإرجاع؛ low إذا وُجد `JsonResource` للموديل.
- **Detect:** لكل موديل معروف الجدول: أعمدة الجدول التي يطابق اسمها `^(password|remember_token|two_factor_secret|two_factor_recovery_codes|api_token|api_key|secret|client_secret|access_token|refresh_token|otp|pin_code)$` أو `_(secret|token|password|api_key)$` (مع استثناء `_at`, `_type`, `_id`)، والعمود غير موجود في `$hidden`، و(`$visible` غير معرّف أو يحتوي العمود). مصادر `$hidden`: الخاصية، و`makeHidden`/`setHidden` على مستوى الموديل غير محسوبة ثابتًا.
- **Not a finding when:** `$visible` معرّف ولا يحتوي العمود (القائمة البيضاء تخفي كل ما سواها)؛ العمود في `$hidden`؛ الموديل لا يُسلسل إلى JSON أبدًا ويوجد `JsonResource` يحدد الحقول (اخفض بدل الإلغاء إن لم يتأكد)؛ أعمدة الإطار في جداول لا موديل لها.
- **Why it matters:** إرجاع موديل من Controller يحوّله Laravel إلى JSON بكل أعمدته غير المخفية، بما فيها التجزئات والرموز، وكذلك في `toArray()` والطوابير والسجلات والإشعارات. تسريب تجزئة كلمة المرور يسمح بكسرها خارج الخادم، وتسريب الرمز يعطي دخولًا مباشرًا.
- **Fix:** أضف الأعمدة إلى `$hidden` (حتى لو كانت مجزأة)، واعرض البيانات عبر API Resources بحقول صريحة.
```sql
-- لا تغيير في القاعدة
```
```php
class User extends Authenticatable {
    protected $hidden = ['password', 'remember_token', 'two_factor_secret', 'two_factor_recovery_codes'];
}
class UserResource extends JsonResource {
    public function toArray(Request $request): array {
        return ['id' => $this->id, 'name' => $this->name, 'email' => $this->email];
    }
}
```
- **References:** https://laravel.com/docs/11.x/eloquent-serialization#hiding-attributes-from-json · https://laravel.com/docs/11.x/eloquent-resources · https://owasp.org/API-Security/editions/2023/en/0xa3-broken-object-property-level-authorization/

## SEC05 · بيانات شخصية حساسة في عمود نصي عادي
- **Severity:** info — ارفعها إلى warning لأرقام الهوية الوطنية والجوازات والحسابات البنكية (`national_id`, `iqama`, `passport_*`, `iban`, `bank_account`)؛ وإلى error لأرقام البطاقات الكاملة و`cvv` (PCI DSS يمنع تخزين CVV بعد التفويض كليًا).
- **Confidence:** medium من المخطط وحده (لا يُعرف من النوع إن كانت القيمة مشفرة بتشفير التطبيق، فـ cast `encrypted` يخزن نصًا أيضًا)؛ high إذا توفر الكود وتأكد غياب cast `encrypted*` للعمود؛ low إذا لم يتوفر الكود.
- **Detect:** أعمدة نوعها `text`/`varchar`/`char` (أو `bigint`/`integer` لأرقام الهوية والبطاقات) واسمها يطابق `(^|_)(national_id|nid|ssn|social_security|iqama|passport(_no|_number)?|id_number|identity_number|tax_id|iban|bank_account|account_number|card_number|pan|cvv|cvc|date_of_birth|dob|birth_date|medical|diagnosis|blood_type)($|_)`. مع الكود: استبعد ما له cast `encrypted*`.
- **Not a finding when:** أعمدة مقنّعة أو جزئية (`card_last4`, `last_four`, `*_last4`, `*_masked`, `card_brand`, `iban_country`)؛ أعمدة `_hash`/`_digest`/`_encrypted` أو نوع `bytea`؛ رموز بوابة الدفع (`stripe_payment_method_id`, `card_token`) لأنها ليست الرقم نفسه؛ الموديل يشفّر العمود بـ cast `encrypted`.
- **Why it matters:** هذه البيانات تُستخدم لانتحال الهوية والاحتيال المالي، وتسريبها يخضع لقوانين حماية البيانات (مثل نظام حماية البيانات الشخصية السعودي وGDPR) ولمعايير PCI DSS للبطاقات. تخزينها نصًا صريحًا يجعل كل نسخة احتياطية وكل صلاحية قراءة نقطة تسريب.
- **Fix:** لا تخزن ما لا تحتاجه (CVV أبدًا، والبطاقة عبر رمز البوابة)، وشفّر الباقي بـ cast `encrypted`، وأضف عمود hash منفصلًا إن لزم البحث بالمطابقة التامة.
```sql
ALTER TABLE public.customers ADD COLUMN national_id_hash text;
CREATE INDEX CONCURRENTLY customers_national_id_hash_index ON public.customers (national_id_hash);
```
```php
protected function casts(): array {
    return ['national_id' => 'encrypted'];
}
// للبحث: hash_hmac('sha256', $nationalId, config('app.key'))
```
- **References:** https://cheatsheetseries.owasp.org/cheatsheets/Cryptographic_Storage_Cheat_Sheet.html · https://laravel.com/docs/11.x/eloquent-mutators#encrypted-casting · https://www.postgresql.org/docs/current/pgcrypto.html
