// A code-derived billing snapshot for discussion. It does not query production.
function table(name, description, definition) {
  const columns = definition.trim().split('\n').map((line, index) => {
    const [columnName, type, flags = '', note = ''] = line.trim().split('|');

    return {
      number: index + 1,
      name: columnName,
      type,
      nullable: !flags.includes('r') && !flags.includes('p'),
      default: null,
      description: note,
      primary: flags.includes('p'),
      unique: flags.includes('u'),
      foreign: flags.includes('f')
    };
  });

  return {
    id: name,
    schema: 'public',
    name,
    description,
    approxRows: 0,
    columns
  };
}

function relation(source, sourceColumn, target) {
  return {
    id: `${source}.${sourceColumn}`,
    name: `${source}_${sourceColumn}_foreign`,
    source,
    target,
    pairs: [{ source: sourceColumn, target: 'id' }],
    onDelete: 'a',
    kind: 'actual'
  };
}

function proposedTable(name, description, definition) {
  return {
    ...table(name, description, definition),
    kind: 'proposed'
  };
}

function proposedRelation(source, sourceColumn, target) {
  return {
    ...relation(source, sourceColumn, target),
    kind: 'proposed'
  };
}

export function sufraProductsSchema() {
  const tables = [
    table(
      'billing_products',
      'كتالوج ما تبيعه Sufra. unit_price وسعر الفترة في جدول الأسعار مصدران حاليان مختلفان.',
      `id|bigint|p
uuid|uuid|ru
code|varchar(80)|ru
name|varchar|r
name_ar|varchar|
name_en|varchar|
description|text|
description_ar|text|
description_en|text|
kind|varchar(20)|r
unit_price|numeric(12,2)|
monthly_price|numeric(12,2)||حقل قديم ما زال في البنية
annual_price|numeric(12,2)||حقل قديم ما زال في البنية
one_time_price|numeric(12,2)||حقل قديم ما زال في البنية
capabilities|jsonb|
quantity_key|varchar(40)|
is_active|boolean|r
sort_order|integer|r
created_at|timestamptz|
updated_at|timestamptz|`
    ),
    table(
      'billing_product_prices',
      'أسعار المنتج حسب العملة والفترة وتاريخ بدء السريان.',
      `id|bigint|p
uuid|uuid|ru
billing_product_id|bigint|rf
currency_id|bigint|rf
billing_interval|varchar(20)|r
unit_price|numeric(12,2)|r
is_active|boolean|r
effective_from|date|
created_at|timestamptz|
updated_at|timestamptz|`
    ),
    table(
      'currencies',
      'جدول مرجعي للعملات المستخدمة في السعر والعرض والاشتراك والدفع.',
      `id|bigint|p
uuid|uuid|ru
code|varchar(3)|ru
name|varchar|r
symbol|varchar(10)|
is_active|boolean|r
created_at|timestamptz|
updated_at|timestamptz|`
    ),
    table(
      'prospects',
      'عميل محتمل قبل إنشاء المتجر؛ لا يصبح متجرًا حتى تأكيد الدفع.',
      `id|bigint|p
uuid|uuid|ru
store_name|varchar|r
phone|varchar|r
address|varchar|
owner_name|varchar|r
owner_email|varchar|r
owner_phone|varchar|r
source|varchar(20)|r
sales_stage|varchar(30)|r
assigned_admin_id|bigint|f
sales_notes|text|
lost_reason|text|
converted_at|timestamptz|
created_store_id|bigint|f
created_at|timestamptz|
updated_at|timestamptz|`
    ),
    table(
      'quotes',
      'عقد البيع قبل الدفع، ويمكن ربطه بمتجر قائم عند التجديد.',
      `id|bigint|p
uuid|uuid|ru
quote_number|varchar|ru
prospect_id|bigint|rf
store_id|bigint|f
custom_plan_name|varchar|
status|varchar(20)|r
currency_id|bigint|rf
billing_interval|varchar(20)|r
valid_until|date|r
subtotal|numeric(12,2)|r
discount_total|numeric(12,2)|r
discount_reason|text|
tax_rate|numeric(6,3)|r
tax_total|numeric(12,2)|r
grand_total|numeric(12,2)|r
notes|text|
customer_notes|text|
sent_at|timestamptz|
sent_by_admin_id|bigint|f
sent_via|varchar(20)|
accepted_at|timestamptz|
accepted_by_admin_id|bigint|f
acceptance_note|text|
cancelled_at|timestamptz|
payment_confirmed_at|timestamptz|
payment_confirmed_by_admin_id|bigint|f
created_at|timestamptz|
updated_at|timestamptz|`
    ),
    table(
      'quote_items',
      'بنود العرض مع نسخ الاسم والقدرات والسعر وقت التعاقد.',
      `id|bigint|p
uuid|uuid|ru
quote_id|bigint|rf
billing_product_id|bigint|f
product_code_snapshot|varchar|r
name_snapshot|varchar|r
description_snapshot|text|
kind_snapshot|varchar(20)|r
capabilities_snapshot|jsonb|
quantity_key_snapshot|varchar(40)|
billing_interval_snapshot|varchar(20)|
quantity|integer|r
list_unit_price|numeric(12,2)|r
unit_price|numeric(12,2)|r
discount_type|varchar(20)|r
discount_value|numeric(12,2)|r
discount_amount|numeric(12,2)|r
line_total|numeric(12,2)|r
sort_order|integer|r
created_at|timestamptz|
updated_at|timestamptz|`
    ),
    table(
      'quote_events',
      'تاريخ أحداث عرض السعر وتغييرات الحالة.',
      `id|bigint|p
quote_id|bigint|rf
actor_admin_id|bigint|f
event|varchar(30)|r
before|jsonb|
after|jsonb|
created_at|timestamptz|
updated_at|timestamptz|`
    ),
    table(
      'subscriptions',
      'فترة اشتراك ناتجة عن عرض مدفوع؛ قد تكون نشطة أو مجدولة.',
      `id|bigint|p
uuid|uuid|ru
store_id|bigint|rf
quote_id|bigint|rfu
status|varchar(20)|r
currency_id|bigint|rf
billing_interval|varchar(20)|r
starts_at|timestamptz|r
ends_at|timestamptz|r
subtotal|numeric(12,2)|r
discount_total|numeric(12,2)|r
tax_total|numeric(12,2)|r
grand_total|numeric(12,2)|r
capabilities|jsonb|
quantities|jsonb|
custom_plan_name|varchar|
created_at|timestamptz|
updated_at|timestamptz|`
    ),
    table(
      'subscription_items',
      'نسخة تعاقدية للبنود المتكررة، بلا FK مباشر إلى المنتج.',
      `id|bigint|p
uuid|uuid|ru
subscription_id|bigint|rf
product_code_snapshot|varchar|r
name_snapshot|varchar|r
description_snapshot|text|
kind_snapshot|varchar(20)|
billing_interval_snapshot|varchar(20)|
quantity_key_snapshot|varchar(40)|
quantity|integer|r
current_quantity|integer|r
list_unit_price|numeric(12,2)|
unit_price|numeric(12,2)|r
discount_type|varchar(20)|
discount_value|numeric(12,2)|
discount_amount|numeric(12,2)|r
line_total|numeric(12,2)|r
capabilities_snapshot|jsonb|
sort_order|integer|r
created_at|timestamptz|
updated_at|timestamptz|`
    ),
    table(
      'subscription_adjustments',
      'تغيير مدفوع أثناء الفترة؛ البنود والتغيرات محفوظة داخل changes JSONB.',
      `id|bigint|p
uuid|uuid|ru
subscription_id|bigint|rf
currency_id|bigint|rf
status|varchar(20)|r
changes|jsonb|r
priced_at|timestamptz|r
valid_until|timestamptz|r
subtotal|numeric(12,2)|r
discount_total|numeric(12,2)|r
discount_reason|text|
tax_rate|numeric(5,2)|r
tax_total|numeric(12,2)|r
grand_total|numeric(12,2)|r
reason|text|r
customer_notes|text|
created_by_admin_id|bigint|rf
applied_by_admin_id|bigint|f
cancelled_by_admin_id|bigint|f
effective_at|timestamptz|
cancelled_at|timestamptz|
created_at|timestamptz|
updated_at|timestamptz|`
    ),
    table(
      'platform_payments',
      'دفعة يثبتها مسؤول، مرتبطة بالعرض أو تعديل الاشتراك.',
      `id|bigint|p
uuid|uuid|ru
store_id|bigint|rf
currency_id|bigint|rf
recorded_by|bigint|rf
amount|numeric(10,2)|r
payment_method|varchar(30)|r
notes|text|
idempotency_key|varchar(64)|u
quote_id|bigint|f
subscription_id|bigint|f
subscription_adjustment_id|bigint|fu
payment_reference|varchar|
created_at|timestamptz|r`
    ),
    table(
      'stores',
      'جدول طرفي مختصر: المتجر الذي يمتلك الاشتراك، وليس كامل نطاق المتجر.',
      `id|bigint|p
uuid|uuid|ru
owner_id|bigint|ru
identifier|varchar|ru
name|varchar|
status|varchar(20)|r
currency_id|bigint|rf
created_at|timestamptz|
updated_at|timestamptz|
deleted_at|timestamptz|`
    ),
    table(
      'administrators',
      'جدول طرفي مختصر: من أنشأ أو اعتمد العرض والتعديل والدفعة.',
      `id|bigint|p
uuid|uuid|ru
name|varchar|r
email|varchar|ru
role|varchar(20)|r
is_active|boolean|r
created_at|timestamptz|
updated_at|timestamptz|`
    ),
    table(
      'users',
      'مرجع مختصر للمستخدم الذي يعتمد الجهاز أو يلغي تفعيله من لوحة Partner.',
      `id|bigint|p
uuid|uuid|ru
name|varchar|r
email|varchar|ru
is_active|boolean|r
created_at|timestamptz|
updated_at|timestamptz|`
    ),
    proposedTable(
      'store_devices',
      'مقترح: طلب الجهاز واعتماده ونوعه في جدول واحد. POS الرئيسي لا يُلغى إلا بالاستبدال.',
      `id|bigint|p
uuid|uuid|ru
store_id|bigint|rf
name|varchar(120)|r
platform|varchar(20)|r
device_key_hash|varchar(255)|ru
mode|varchar(10)||POS / KDS / Waiter؛ يحدد عند الاعتماد
status|varchar(20)|r|pending / approved / deactivated / replaced
is_primary_pos|boolean|r
approved_by_user_id|bigint|f
approved_at|timestamptz|
deactivated_by_user_id|bigint|f
deactivated_at|timestamptz|
last_seen_at|timestamptz|
created_at|timestamptz|
updated_at|timestamptz|`
    )
  ];

  const relations = [
    relation('billing_product_prices', 'billing_product_id', 'billing_products'),
    relation('billing_product_prices', 'currency_id', 'currencies'),
    relation('prospects', 'assigned_admin_id', 'administrators'),
    relation('prospects', 'created_store_id', 'stores'),
    relation('quotes', 'prospect_id', 'prospects'),
    relation('quotes', 'store_id', 'stores'),
    relation('quotes', 'currency_id', 'currencies'),
    relation('quotes', 'sent_by_admin_id', 'administrators'),
    relation('quotes', 'accepted_by_admin_id', 'administrators'),
    relation('quotes', 'payment_confirmed_by_admin_id', 'administrators'),
    relation('quote_items', 'quote_id', 'quotes'),
    relation('quote_items', 'billing_product_id', 'billing_products'),
    relation('quote_events', 'quote_id', 'quotes'),
    relation('quote_events', 'actor_admin_id', 'administrators'),
    relation('subscriptions', 'store_id', 'stores'),
    relation('subscriptions', 'quote_id', 'quotes'),
    relation('subscriptions', 'currency_id', 'currencies'),
    relation('subscription_items', 'subscription_id', 'subscriptions'),
    relation('subscription_adjustments', 'subscription_id', 'subscriptions'),
    relation('subscription_adjustments', 'currency_id', 'currencies'),
    relation('subscription_adjustments', 'created_by_admin_id', 'administrators'),
    relation('subscription_adjustments', 'applied_by_admin_id', 'administrators'),
    relation('subscription_adjustments', 'cancelled_by_admin_id', 'administrators'),
    relation('platform_payments', 'store_id', 'stores'),
    relation('platform_payments', 'currency_id', 'currencies'),
    relation('platform_payments', 'recorded_by', 'administrators'),
    relation('platform_payments', 'quote_id', 'quotes'),
    relation('platform_payments', 'subscription_id', 'subscriptions'),
    relation('platform_payments', 'subscription_adjustment_id', 'subscription_adjustments'),
    relation('stores', 'currency_id', 'currencies'),
    proposedRelation('store_devices', 'store_id', 'stores'),
    proposedRelation('store_devices', 'approved_by_user_id', 'users'),
    proposedRelation('store_devices', 'deactivated_by_user_id', 'users')
  ];

  return {
    database: 'Sufra Products / Billing · current + proposed devices',
    tables,
    relations,
    readOnly: true
  };
}

export const sufraProductTopics = [
  {
    id: 'catalog',
    label: 'الكتالوج والأسعار',
    color: '#6551C7',
    ids: ['billing_products', 'billing_product_prices', 'currencies']
  },
  {
    id: 'quotes',
    label: 'المبيعات والعروض',
    color: '#C67966',
    ids: ['prospects', 'quotes', 'quote_items', 'quote_events', 'billing_products']
  },
  {
    id: 'subscriptions',
    label: 'الاشتراكات والتعديلات',
    color: '#7B9A78',
    ids: ['stores', 'subscriptions', 'subscription_items', 'subscription_adjustments']
  },
  {
    id: 'payments',
    label: 'المدفوعات والمسؤولون',
    color: '#B69060',
    ids: ['platform_payments', 'administrators', 'quotes', 'subscription_adjustments']
  },
  {
    id: 'devices',
    label: 'أجهزة التشغيل · مقترح',
    color: '#8B68CE',
    ids: ['store_devices', 'users', 'stores', 'subscriptions']
  }
];
