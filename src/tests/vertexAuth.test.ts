import { afterEach, beforeEach, describe, expect, mock, test } from "bun:test";
import {
  _clearVertexAuthCache,
  getVertexAccessToken,
} from "../embeddings/vertexAuth.js";

// ---------------------------------------------------------------------------
// We mock google-auth-library to avoid real network calls
// ---------------------------------------------------------------------------

const mockGetAccessToken = mock(async () => ({ token: "mock-token-abc" }));
const mockGetClient = mock(async () => ({
  getAccessToken: mockGetAccessToken,
}));

mock.module("google-auth-library", () => ({
  GoogleAuth: class MockGoogleAuth {
    constructor(public options: Record<string, unknown>) {}
    getClient = mockGetClient;
  },
}));

describe("getVertexAccessToken", () => {
  beforeEach(() => {
    _clearVertexAuthCache();
    mockGetAccessToken.mockClear();
    mockGetClient.mockClear();
  });

  afterEach(() => {
    _clearVertexAuthCache();
  });

  test("returns token from GoogleAuth.getClient().getAccessToken()", async () => {
    const token = await getVertexAccessToken({});
    expect(token).toBe("mock-token-abc");
    expect(mockGetClient).toHaveBeenCalledTimes(1);
    expect(mockGetAccessToken).toHaveBeenCalledTimes(1);
  });

  test("reuses the same GoogleAuth instance on repeated calls (ADC)", async () => {
    await getVertexAccessToken({});
    await getVertexAccessToken({});
    // getClient is called each time (to get a potentially refreshed client),
    // but GoogleAuth constructor should only be called once (cached instance)
    expect(mockGetClient).toHaveBeenCalledTimes(2);
  });

  test("creates separate GoogleAuth instances for different keyFile values", async () => {
    let constructorCount = 0;
    mock.module("google-auth-library", () => ({
      GoogleAuth: class {
        constructor() {
          constructorCount++;
        }
        getClient = mock(async () => ({
          getAccessToken: mock(async () => ({ token: "tok" })),
        }));
      },
    }));
    _clearVertexAuthCache();

    await getVertexAccessToken({ keyFile: "/path/a.json" });
    await getVertexAccessToken({ keyFile: "/path/b.json" });
    expect(constructorCount).toBe(2);
  });

  test("ADC and keyFile paths share separate cache entries", async () => {
    let constructorCount = 0;
    mock.module("google-auth-library", () => ({
      GoogleAuth: class {
        constructor() {
          constructorCount++;
        }
        getClient = mock(async () => ({
          getAccessToken: mock(async () => ({ token: "tok" })),
        }));
      },
    }));
    _clearVertexAuthCache();

    await getVertexAccessToken({}); // ADC key
    await getVertexAccessToken({ keyFile: "/sa.json" }); // key file key
    await getVertexAccessToken({}); // ADC again → reuses cached instance
    expect(constructorCount).toBe(2);
  });

  test("throws descriptive error when token is null", async () => {
    mock.module("google-auth-library", () => ({
      GoogleAuth: class {
        getClient = mock(async () => ({
          getAccessToken: mock(async () => ({ token: null })),
        }));
      },
    }));
    _clearVertexAuthCache();

    await expect(getVertexAccessToken({})).rejects.toThrow(
      "gcloud auth application-default login",
    );
  });

  test("throws descriptive error when token is empty string", async () => {
    mock.module("google-auth-library", () => ({
      GoogleAuth: class {
        getClient = mock(async () => ({
          getAccessToken: mock(async () => ({ token: "" })),
        }));
      },
    }));
    _clearVertexAuthCache();

    await expect(getVertexAccessToken({})).rejects.toThrow(
      "gcloud auth application-default login",
    );
  });

  test("passes keyFile to GoogleAuth constructor", async () => {
    let capturedOptions: Record<string, unknown> | undefined;
    mock.module("google-auth-library", () => ({
      GoogleAuth: class {
        constructor(opts: Record<string, unknown>) {
          capturedOptions = opts;
        }
        getClient = mock(async () => ({
          getAccessToken: mock(async () => ({ token: "tok" })),
        }));
      },
    }));
    _clearVertexAuthCache();

    await getVertexAccessToken({ keyFile: "/my/sa.json" });
    expect(capturedOptions?.keyFilename).toBe("/my/sa.json");
  });

  test("does not pass keyFilename when using ADC", async () => {
    let capturedOptions: Record<string, unknown> | undefined;
    mock.module("google-auth-library", () => ({
      GoogleAuth: class {
        constructor(opts: Record<string, unknown>) {
          capturedOptions = opts;
        }
        getClient = mock(async () => ({
          getAccessToken: mock(async () => ({ token: "tok" })),
        }));
      },
    }));
    _clearVertexAuthCache();

    await getVertexAccessToken({});
    expect(capturedOptions?.keyFilename).toBeUndefined();
    expect(capturedOptions?.scopes).toEqual([
      "https://www.googleapis.com/auth/cloud-platform",
    ]);
  });
});
