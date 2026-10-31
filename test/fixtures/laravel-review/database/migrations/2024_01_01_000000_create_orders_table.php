<?php

use Illuminate\Database\Migrations\Migration;
use Illuminate\Database\Schema\Blueprint;
use Illuminate\Support\Facades\DB;
use Illuminate\Support\Facades\Schema;

return new class extends Migration
{
    public function up(): void
    {
        Schema::create('orders', function (Blueprint $table) {
            $table->id();
            $table->enum('channel', ['web', 'pos']);
            $table->foreignId('user_id')->constrained();
        });
        Schema::create('legacy_reports', function (Blueprint $table) {
            $table->id();
        });
        $name = 'orders';
        DB::statement("ALTER TABLE {$name} SET (fillfactor = 90)");
    }
};
