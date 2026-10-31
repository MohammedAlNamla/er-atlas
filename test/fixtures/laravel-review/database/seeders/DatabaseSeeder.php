<?php

namespace Database\Seeders;

use App\Models\Order;
use Illuminate\Database\Seeder;

class DatabaseSeeder extends Seeder
{
    public function run(): void
    {
        Order::unguard();
    }
}
