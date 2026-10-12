# Sufra Products / Billing — المخطط الحالي

هذه لقطة من migrations والموديلات في `sufra-api` بتاريخ 2026-09-27، وليست قراءة
مباشرة من قاعدة staging أو production. افتح ER Atlas واختر مساحة
**Sufra · Products الحالي**؛ فيها 13 جدولًا و207 أعمدة و30 علاقة FK، مع مواضيع
للكتالوج، العروض، الاشتراكات، والمدفوعات. يمكن اقتراح التعديلات كمسودة دون تغيير
قاعدة البيانات.

```mermaid
erDiagram
    billing_products ||--o{ billing_product_prices : has
    currencies ||--o{ billing_product_prices : prices_in
    prospects ||--o{ quotes : receives
    stores o|--o{ quotes : renews_with
    currencies ||--o{ quotes : quoted_in
    quotes ||--|{ quote_items : contains
    billing_products o|--o{ quote_items : source_of_snapshot
    quotes ||--o{ quote_events : audit
    quotes ||--o| subscriptions : activates
    stores ||--o{ subscriptions : owns
    currencies ||--o{ subscriptions : billed_in
    subscriptions ||--|{ subscription_items : freezes
    subscriptions ||--o{ subscription_adjustments : changed_by
    currencies ||--o{ subscription_adjustments : priced_in
    stores ||--o{ platform_payments : pays
    quotes o|--o{ platform_payments : paid_for
    subscriptions o|--o{ platform_payments : covers
    subscription_adjustments o|--o| platform_payments : paid_by
    administrators ||--o{ platform_payments : records

    billing_products {
        bigint id PK
        varchar code UK
        varchar kind
        numeric unit_price
        jsonb capabilities
        varchar quantity_key
    }
    billing_product_prices {
        bigint id PK
        bigint billing_product_id FK
        bigint currency_id FK
        varchar billing_interval
        numeric unit_price
        date effective_from
    }
    currencies {
        bigint id PK
        varchar code UK
        varchar symbol
    }
    prospects {
        bigint id PK
        varchar sales_stage
        bigint assigned_admin_id FK
        bigint created_store_id FK
    }
    quotes {
        bigint id PK
        bigint prospect_id FK
        bigint store_id FK
        bigint currency_id FK
        varchar status
        numeric grand_total
    }
    quote_items {
        bigint id PK
        bigint quote_id FK
        bigint billing_product_id FK
        varchar product_code_snapshot
        numeric list_unit_price
        numeric unit_price
    }
    quote_events {
        bigint id PK
        bigint quote_id FK
        bigint actor_admin_id FK
        varchar event
    }
    stores {
        bigint id PK
        bigint currency_id FK
        varchar identifier
    }
    subscriptions {
        bigint id PK
        bigint store_id FK
        bigint quote_id FK, UK
        varchar status
        timestamp starts_at
        timestamp ends_at
    }
    subscription_items {
        bigint id PK
        bigint subscription_id FK
        varchar product_code_snapshot
        integer quantity
        integer current_quantity
    }
    subscription_adjustments {
        bigint id PK
        bigint subscription_id FK
        bigint currency_id FK
        jsonb changes
        varchar status
        numeric grand_total
    }
    platform_payments {
        bigint id PK
        bigint store_id FK
        bigint quote_id FK
        bigint subscription_id FK
        bigint subscription_adjustment_id FK, UK
        numeric amount
    }
    administrators {
        bigint id PK
        varchar email UK
        varchar role
    }
```

المخطط النصي يبرز علاقات البيع فقط. مساحة ER Atlas تعرض كذلك كل علاقات
المسؤولين والعملات، والأعمدة التفصيلية للخصومات والضرائب وحالات الاعتماد.
`stores` و`administrators` معروضان كجداول طرفية مختصرة؛ باقي حقولهما خارج نطاق
المنتجات. لا توجد جداول لرخص الأجهزة المقترحة هنا.

## نقاط تستحق النقاش

1. **مصدر السعر:** لدى `billing_products` سعر عام وحقول سعر فترة قديمة، وفي
   المقابل `billing_product_prices` حسب العملة والفترة. أيها المصدر المعتمد؟
   العرض يقبل الرجوع للسعر العام، لكن تعديل الاشتراك يحتاج سعر الفترة/العملة.
2. **ثبات العقد:** `quote_items` يحتفظ بنسخة المنتج وله FK اختياري للكتالوج؛
   `subscription_items` يحتفظ بنسخة تعاقدية بلا FK للمنتج. تغيير المنتج لاحقًا
   لا ينبغي أن يعيد كتابة عقد سابق.
3. **التعديل أثناء الفترة:** ليس له جدول `adjustment_items`؛ تفاصيل التغيير داخل
   `subscription_adjustments.changes` من نوع JSONB، بينما `current_quantity`
   في `subscription_items` تمثل الحالة الجارية. هل هذا كافٍ للتقارير والتدقيق؟
4. **التجديد:** العرض الجديد ينشئ صفًا جديدًا في `subscriptions` للفترة القادمة؛
   لا يمدد الصف القديم. العلاقة `quotes` ← `subscriptions` واحد إلى صفر/واحد.
5. **الدفع:** `platform_payments` يرتبط بالمتجر والعملات والمسؤول، وقد يرتبط
   بعرض/اشتراك أو بتعديل اشتراك. حقل `subscription_adjustment_id` فريد، أي
   دفعة واحدة كحد أقصى لكل تعديل في النموذج الحالي.

المصادر الأساسية: `sufra-api/database/migrations/2026_09_08_000002_create_billing_catalog_tables.php`،
`2026_09_08_000003_create_quotes_tables.php`،
`2026_09_08_000005_create_subscriptions_tables.php`،
`2026_09_12_000001_create_subscription_adjustments_table.php`،
مع migrations اللاحقة للحقول وإعادة التسمية.
