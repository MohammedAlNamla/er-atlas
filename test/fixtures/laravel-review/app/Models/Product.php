<?php

namespace App\Models;

use Illuminate\Database\Eloquent\Model;
use Illuminate\Database\Eloquent\SoftDeletes;

class Product extends Model
{
    use SoftDeletes;

    protected $table = 'products';

    protected $fillable = ['name', 'sku', 'price', 'secret_note'];

    protected $casts = ['secret_note' => 'encrypted'];

    public function items()
    {
        return $this->hasMany(OrderItem::class);
    }
}
