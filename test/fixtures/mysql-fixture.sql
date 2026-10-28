-- A small Laravel-shaped MySQL/MariaDB schema for trying ER Atlas against a real server.
-- It covers what the reader must get right: composite and single keys, ON DELETE rules, enums,
-- tinyint(1) booleans, JSON, comments, CHECK constraints, a MyISAM table without foreign keys,
-- and a polymorphic events table whose *_type column holds a class name and a morph-map alias.
-- Load:   mysql -u root -e "CREATE DATABASE er_atlas_mysql_test" && mysql -u root er_atlas_mysql_test < test/fixtures/mysql-fixture.sql
-- Remove: mysql -u root -e "DROP DATABASE er_atlas_mysql_test"

CREATE TABLE users (
  id bigint unsigned NOT NULL AUTO_INCREMENT,
  name varchar(255) NOT NULL,
  email varchar(255) NOT NULL,
  is_admin tinyint(1) NOT NULL DEFAULT 0,
  status enum('active','blocked') NOT NULL DEFAULT 'active' COMMENT 'Account state',
  created_at timestamp NULL DEFAULT CURRENT_TIMESTAMP,
  PRIMARY KEY (id),
  UNIQUE KEY users_email_unique (email)
) ENGINE=InnoDB COMMENT='People who sign in';

CREATE TABLE orders (
  id bigint unsigned NOT NULL AUTO_INCREMENT,
  user_id bigint unsigned NOT NULL,
  total decimal(12,2) NOT NULL DEFAULT 0.00,
  meta json DEFAULT NULL,
  PRIMARY KEY (id),
  KEY orders_user_id_index (user_id),
  CONSTRAINT orders_user_id_foreign FOREIGN KEY (user_id) REFERENCES users (id) ON DELETE CASCADE,
  CONSTRAINT orders_total_positive CHECK (total >= 0)
) ENGINE=InnoDB;

CREATE TABLE products (
  id bigint unsigned NOT NULL AUTO_INCREMENT,
  sku varchar(64) NOT NULL,
  PRIMARY KEY (id),
  UNIQUE KEY products_sku_unique (sku)
) ENGINE=InnoDB;

CREATE TABLE order_items (
  order_id bigint unsigned NOT NULL,
  product_id bigint unsigned NOT NULL,
  quantity int(11) NOT NULL DEFAULT 1,
  PRIMARY KEY (order_id, product_id),
  CONSTRAINT order_items_order_id_foreign FOREIGN KEY (order_id) REFERENCES orders (id) ON DELETE CASCADE,
  CONSTRAINT order_items_product_id_foreign FOREIGN KEY (product_id) REFERENCES products (id) ON DELETE RESTRICT
) ENGINE=InnoDB;

CREATE TABLE events (
  id bigint unsigned NOT NULL AUTO_INCREMENT,
  eventable_type varchar(255) NOT NULL,
  eventable_id bigint unsigned NOT NULL,
  action varchar(32) NOT NULL,
  PRIMARY KEY (id),
  KEY events_eventable_type_eventable_id_index (eventable_type, eventable_id)
) ENGINE=InnoDB;

-- MyISAM ignores foreign keys, as many older MySQL schemas do: user_id links nothing in the catalog.
CREATE TABLE legacy_logs (
  id int(11) NOT NULL AUTO_INCREMENT,
  user_id int(11) DEFAULT NULL,
  message text,
  PRIMARY KEY (id)
) ENGINE=MyISAM;

INSERT INTO users (name, email) VALUES ('Ada', 'ada@example.test');
INSERT INTO orders (user_id, total) VALUES (1, 10.50);
INSERT INTO events (eventable_type, eventable_id, action) VALUES ('App\\Models\\Order', 1, 'created'), ('user', 1, 'signed_in');
