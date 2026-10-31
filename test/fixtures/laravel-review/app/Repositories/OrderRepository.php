<?php

namespace App\Repositories;

use App\Models\Order;

class OrderRepository
{
    public function __construct(private Order $model) {}

    public function byReference(string $reference)
    {
        return $this->model->where('reference', $reference)->first();
    }

    public function forUser(int $userId)
    {
        return $this->model->newQuery()->where('user_id', $userId)->latest()->get();
    }

    public function search(string $term)
    {
        return $this->model->where('notes', 'like', "%{$term}%")->get();
    }
}
