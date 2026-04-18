// NomicCodeEmbeddings is kept for backwards compatibility.
// nomic-ai/nomic-embed-code has no ONNX files on HuggingFace Hub and cannot
// be loaded by @huggingface/transformers. JinaCodeEmbeddings is the
// replacement with equivalent dimensions, context window, and code awareness.
export { JinaCodeEmbeddings as NomicCodeEmbeddings } from "./JinaCodeEmbeddings.js";
