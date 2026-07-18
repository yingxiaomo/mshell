export function TunnelsView() {
  return (
    <div className="flex h-full flex-col">
      <div className="border-b border-zinc-800 px-4 py-3">
        <h1 className="text-sm font-semibold tracking-wide text-zinc-200">
          隧道
        </h1>
      </div>
      <div className="flex flex-1 items-center justify-center p-4">
        <p className="text-center text-sm text-zinc-500">
          暂无隧道。连接配置中可添加端口转发
        </p>
      </div>
    </div>
  );
}
