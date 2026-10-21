# أدلة المراجعة (Playbooks)

كل ملف هنا هو دليل خبرة لتخصص واحد من تخصصات مراجعة قاعدة البيانات المعرّفة في `review/catalog.js`. الدليل هو المرجع الوحيد لمعنى كل فحص: لماذا هو مشكلة، وكيف يُكتشف، ومتى لا يكون مشكلة، وكيف يُصلح. المعرّفات (`SD01`، `IX01`…) والخطورة الافتراضية والأدلة المطلوبة تأتي من الكتالوج ولا تُعرّف هنا من جديد.

## من يقرأ الدليل

1. **المحرك (`review/engine.js`)** يطبّق الفحوص الحتمية. قسم **Detect** هو مواصفة التنفيذ، وقسم **Not a finding when** هو قائمة الاستثناءات التي يجب أن يطبّقها قبل إصدار أي نتيجة. إذا اختلف التنفيذ عن الدليل فأحدهما خطأ ويجب توحيدهما.
2. **المراجع الذكي (AI)** يُحقن نص الدليل في تعليماته. قسم **How to judge (AI)** يحدد كيف يرتّب النتائج ويشرحها ومتى يخفض الثقة. لا يضيف نتيجة جديدة إلا بدليل ملموس من المدخلات (جدول.عمود، ملف:سطر، رقم إحصاء، عملية مسودة).
3. **الواجهة** تعرض قسم الفحص `## <ID> · …` عند فتح نتيجة: **Why it matters** و**Fix** و**References** للمستخدم.

## الصيغة (يحللها الخادم حرفيًا)

```
---
id: <معرّف التخصص من الكتالوج>
title: <العنوان العربي من الكتالوج>
version: 1
applies_to: PostgreSQL 12+ · Laravel 9–11
---

# <العنوان العربي>
<مقدمة قصيرة>

## How to judge (AI)
1. …

## <CHECK ID> · <عنوان الفحص من الكتالوج>
- **Severity:** …
- **Confidence:** …
- **Detect:** …
- **Not a finding when:** …
- **Why it matters:** …
- **Fix:** …
- **References:** …
```

- رأس YAML بين سطرين `---` بالمفاتيح الأربعة فقط.
- كل فحص في الكتالوج له قسم واحد فقط، بترتيب الكتالوج، في ملف تخصصه، ويبدأ عنوانه بـ `## <ID> · ` حرفيًا.
- القسم ينتهي عند أول عنوان `## ` تالٍ. الحقول أسطر تبدأ بـ `- **اسم:**`، ومحتوى الحقل يمتد حتى الحقل التالي؛ كتل الكود (```sql و```php) بعد **Fix** تتبع حقل **Fix**.
- النص عربي، والمعرّفات وSQL وPHP بالإنجليزية.

## تعريفات مشتركة تلتزم بها كل الأدلة

- **جدول كبير:** `approxRows ≥ 100,000`. **جدول صغير:** `approxRows < 10,000`. **ضخم:** `≥ 10,000,000`.
- `approxRows` مأخوذ من `pg_stat_user_tables.n_live_tup`؛ القيمة 0 قد تعني جدولًا لم يُحلَّل (`ANALYZE`) بعد، فتُعامل كـ "غير معروف" وتخفض الثقة، إلا إذا كان الجدول مضافًا في المسودة نفسها.
- **جداول الإطار:** `migrations, jobs, job_batches, failed_jobs, password_reset_tokens, password_resets, sessions, cache, cache_locks, personal_access_tokens, notifications` والبادئات `telescope_*`, `pulse_*`, `oauth_*`، وجداول الحزم الشائعة `permissions, roles, model_has_permissions, model_has_roles, role_has_permissions, activity_log, media`.
- **زوج متعدد الأشكال:** عمودان `<x>_id` و`<x>_type` في الجدول نفسه (`morphs()`)؛ لا يمكن أن يكون لـ `<x>_id` مفتاح أجنبي.
- **جدول وسيط (pivot):** جدول له علاقتان أجنبيتان بالضبط وأعمدته الأخرى محصورة في `id` و`created_at`/`updated_at` وأعمدة بيانات قليلة، أو اسمه اسمَا جدولين بالمفرد مرتبين أبجديًا (`role_user`).
- مطابقة الأنواع تستخدم `normalizeType` في `public/lint.js` (`int4 = integer`، `serial = integer`، `timestamp(0) without time zone = timestamp`…).

## English summary

Each file is the expert playbook for one review skill in `review/catalog.js`. The engine implements each check's **Detect** and **Not a finding when** fields exactly; the AI reviewer receives the playbook as judging instructions (the **How to judge (AI)** list) and may only add findings backed by concrete evidence; the UI shows a check's section (**Why it matters**, **Fix**, **References**) when a finding is opened. The server parses the YAML front matter and finds sections by the `## <ID> · ` heading prefix; every catalog check has exactly one section, in catalog order. Shared thresholds: large table = `approxRows ≥ 100,000`, small = `< 10,000`; `approxRows = 0` means unknown unless the table is new in the draft.
