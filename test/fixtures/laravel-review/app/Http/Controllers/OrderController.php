<?php

namespace App\Http\Controllers;

use App\Models\Order;
use App\Models\Product;
use App\Models\User;
use Illuminate\Http\Request;
use Illuminate\Support\Facades\DB;
use Illuminate\Support\Facades\Hash;

class OrderController extends Controller
{
    public function index(Request $request)
    {
        $orders = Order::where('status', $request->input('status'))->orderBy($request->input('sort'))->get();
        $safe = Order::whereRaw('total > ?', [$request->input('min')])->get();
        $rows = DB::select("select * from orders where reference = '{$request->input('q')}'");
        $inMemory = $orders->where('notes', 'x');
        $direction = $request->input('direction');
        $sorted = Order::orderBy('placed_at', $direction)->get();
        $limit = (int) $request->input('limit');
        $capped = DB::select('select * from orders limit ' . self::PAGE);
        $sku = Product::where('sku', $request->input('sku'))->first();
        $users = User::whereEmail($request->input('email'))->get();
        return $orders;
    }

    public function sorted(Request $request)
    {
        $sort = $request->input('sort');
        if (! in_array($sort, ['total', 'placed_at'])) {
            $sort = 'placed_at';
        }
        return Order::orderBy($sort)->get();
    }

    public function report(string $column)
    {
        return DB::select('select ' . $column . ' from orders');
    }

    public function store(Request $request)
    {
        $user = User::create(['name' => $request->name, 'password' => Hash::make($request->password)]);
        return Order::create($request->all());
    }

    public function settings()
    {
        return DB::table('settings')->where('key', 'theme')->first();
    }
}
