// 消息常量单一来源。内容脚本是普通脚本，不能 import，所以由这个文件挂到隔离世界的命名空间上。
window.EZ = window.EZ || {};
window.EZ.MSG = {
  BATCH: "BATCH",
  CANCEL: "CANCEL",
  PING: "PING",
  SEG: "SEG",
  DONE: "DONE",
  ERR: "ERR",
  RATE: "RATE",
  PROGRESS: "PROGRESS",
  TEXT: "TEXT",
  TEXT_DELTA: "TEXT_DELTA",
  TEXT_DONE: "TEXT_DONE",
};
