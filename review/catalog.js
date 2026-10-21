// The database review check catalog: the one place a check gets its id, its skill (playbook in
// review/skills/<skill>.md), its default severity and what evidence it needs. The engine, the
// playbooks, the AI prompt and the UI all speak in these ids, so a finding can always be traced
// back to the rule and the reasoning that produced it.
//
// needs: schema = the read schema; code = the analysed Laravel project; stats = live read-only
// statistics from a connected database; draft = the operations in the current draft.
export const SKILLS = [
  { id: 'schema-design', title: 'تصميم المخطط', prefix: 'SD' },
  { id: 'indexing-performance', title: 'الفهارس والأداء', prefix: 'IX' },
  { id: 'data-integrity', title: 'سلامة البيانات', prefix: 'DI' },
  { id: 'laravel-security', title: 'أمان البيانات في Laravel', prefix: 'SEC' },
  { id: 'code-db-drift', title: 'تطابق الكود مع القاعدة', prefix: 'DR' },
  { id: 'migration-safety', title: 'أمان تنفيذ المسودة', prefix: 'MS' }
];

export const CHECKS = [
  // Schema design
  { id: 'SD01', skill: 'schema-design', severity: 'warning', needs: ['schema'], title: 'جدول بلا مفتاح أساسي' },
  { id: 'SD02', skill: 'schema-design', severity: 'warning', needs: ['schema'], title: 'جدول بلا أعمدة' },
  { id: 'SD03', skill: 'schema-design', severity: 'error', needs: ['schema'], title: 'نوع المفتاح الأجنبي لا يطابق المفتاح الذي يشير إليه' },
  { id: 'SD04', skill: 'schema-design', severity: 'warning', needs: ['schema'], title: 'علاقة مكررة بين الجدولين نفسيهما' },
  { id: 'SD05', skill: 'schema-design', severity: 'info', needs: ['schema'], title: 'جدول معزول بلا أي علاقة' },
  // Indexing and performance
  { id: 'IX01', skill: 'indexing-performance', severity: 'warning', needs: ['schema'], title: 'مفتاح أجنبي بلا فهرس' },
  { id: 'IX02', skill: 'indexing-performance', severity: 'warning', needs: ['schema', 'code'], title: 'عمود يُبحث أو يُرتَّب به في الكود بلا فهرس' },
  { id: 'IX03', skill: 'indexing-performance', severity: 'info', needs: ['schema', 'code'], title: 'SoftDeletes بلا فهرس يخدم deleted_at' },
  { id: 'IX04', skill: 'indexing-performance', severity: 'info', needs: ['schema'], title: 'فهرس مكرر يغطيه فهرس آخر' },
  { id: 'IX05', skill: 'indexing-performance', severity: 'info', needs: ['schema', 'stats'], title: 'فهرس لم يُستخدم منذ آخر تصفير للإحصاءات' },
  { id: 'IX06', skill: 'indexing-performance', severity: 'warning', needs: ['schema', 'stats'], title: 'جدول كبير يُقرأ بمسح كامل أكثر من الفهارس' },
  // Data integrity
  { id: 'DI01', skill: 'data-integrity', severity: 'error', needs: ['schema'], title: 'مبلغ مالي مخزّن بنوع عشري تقريبي' },
  { id: 'DI02', skill: 'data-integrity', severity: 'info', needs: ['schema'], title: 'عمود حالة نصي بلا قيد يحدد قيمه' },
  { id: 'DI03', skill: 'data-integrity', severity: 'error', needs: ['schema'], title: 'SET NULL على عمود لا يقبل NULL' },
  { id: 'DI04', skill: 'data-integrity', severity: 'warning', needs: ['schema'], title: 'حذف متسلسل (CASCADE) إلى جدول كبير' },
  { id: 'DI05', skill: 'data-integrity', severity: 'info', needs: ['schema'], title: 'عمود منطقي يقبل NULL بلا قيمة افتراضية' },
  { id: 'DI06', skill: 'data-integrity', severity: 'info', needs: ['schema'], title: 'وقت حدث مخزّن بلا منطقة زمنية' },
  // Laravel security
  { id: 'SEC01', skill: 'laravel-security', severity: 'error', needs: ['code'], title: 'استعلام SQL خام يدمج متغيرات في النص' },
  { id: 'SEC02', skill: 'laravel-security', severity: 'warning', needs: ['code'], title: 'إسناد جماعي مفتوح أو يشمل أعمدة صلاحيات' },
  { id: 'SEC03', skill: 'laravel-security', severity: 'warning', needs: ['schema', 'code'], title: 'سر أو رمز مخزّن دون تشفير أو تجزئة ظاهرة' },
  { id: 'SEC04', skill: 'laravel-security', severity: 'warning', needs: ['schema', 'code'], title: 'عمود حساس غير مخفي عند تحويل الموديل إلى JSON' },
  { id: 'SEC05', skill: 'laravel-security', severity: 'info', needs: ['schema'], title: 'بيانات شخصية حساسة في عمود نصي عادي' },
  // Code and database drift
  { id: 'DR01', skill: 'code-db-drift', severity: 'warning', needs: ['schema', 'code'], title: 'علاقة Eloquent بلا مفتاح أجنبي في القاعدة' },
  { id: 'DR02', skill: 'code-db-drift', severity: 'error', needs: ['schema', 'code'], title: 'موديل يشير إلى جدول غير موجود' },
  { id: 'DR03', skill: 'code-db-drift', severity: 'info', needs: ['schema', 'code'], title: 'جدول لا يستخدمه أي كود محلَّل' },
  { id: 'DR04', skill: 'code-db-drift', severity: 'warning', needs: ['schema', 'code'], title: 'الموديل يذكر عمودًا غير موجود في الجدول' },
  { id: 'DR05', skill: 'code-db-drift', severity: 'warning', needs: ['schema'], title: 'عمود ربط *_id بلا مفتاح أجنبي' },
  // Draft (migration) safety
  { id: 'MS01', skill: 'migration-safety', severity: 'error', needs: ['schema', 'draft'], title: 'إضافة عمود NOT NULL بلا قيمة افتراضية إلى جدول فيه بيانات' },
  { id: 'MS02', skill: 'migration-safety', severity: 'warning', needs: ['schema', 'draft'], title: 'جعل عمود NOT NULL في جدول فيه بيانات' },
  { id: 'MS03', skill: 'migration-safety', severity: 'warning', needs: ['schema', 'draft'], title: 'تغيير نوع عمود في جدول كبير يعيد كتابته' },
  { id: 'MS04', skill: 'migration-safety', severity: 'error', needs: ['draft', 'code'], title: 'حذف أو إعادة تسمية شيء يستخدمه الكود' },
  { id: 'MS05', skill: 'migration-safety', severity: 'warning', needs: ['schema', 'draft'], title: 'إنشاء فهرس على جدول كبير دون CONCURRENTLY' }
];

export const SEVERITIES = ['error', 'warning', 'info'];
export const CONFIDENCE = ['high', 'medium', 'low'];
export const checkById = new Map(CHECKS.map(check => [check.id, check]));
