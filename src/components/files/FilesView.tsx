export function FilesView() {
  return (
    <div className="flex h-full flex-col">
      <div className="border-b border-zinc-800 px-4 py-3">
        <h1 className="text-sm font-semibold tracking-wide text-zinc-200">
          文件
        </h1>
      </div>
      <div className="flex flex-1 items-center justify-center p-4">
        <p className="text-center text-sm text-zinc-500">
          打开会话后可在此浏览远程文件
        </p>
      </div>
    </div>
  );
}
