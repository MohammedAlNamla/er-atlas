<?php

namespace App\Models;

use Illuminate\Database\Eloquent\Relations\HasMany;
use Illuminate\Foundation\Auth\User as Authenticatable;

class User extends Authenticatable
{
    protected $fillable = ['name', 'email', 'password', 'is_admin', 'nickname'];

    protected $hidden = ['password', 'remember_token', 'orders'];

    protected $appends = ['display_name'];

    protected function casts(): array
    {
        return ['email_verified_at' => 'datetime', 'password' => 'hashed'];
    }

    public function orders(): HasMany
    {
        return $this->hasMany(Order::class);
    }

    public function getDisplayNameAttribute()
    {
        return $this->name;
    }
}
