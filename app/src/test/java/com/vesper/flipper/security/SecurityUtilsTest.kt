package com.vesper.flipper.security

import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertTrue
import org.junit.Assert.fail
import org.junit.Test

class SecurityUtilsTest {

    private val securityUtils = SecurityUtils()

    @Test
    fun testValidatePathValidPaths() {
        assertEquals("/ext/nfc/card.nfc", securityUtils.validatePath("/ext/nfc/card.nfc"))
        assertEquals("/int/settings.json", securityUtils.validatePath("/int/settings.json"))
        assertEquals("/ext", securityUtils.validatePath("/ext"))
        assertEquals("/int", securityUtils.validatePath("/int"))
    }

    @Test
    fun testValidatePathNullByteInjectionThrowsException() {
        try {
            securityUtils.validatePath("/ext/test\u0000.txt")
            fail("Expected SecurityException for null byte injection")
        } catch (e: SecurityException) {
            assertEquals("Path contains null bytes", e.message)
        }
    }

    @Test
    fun testValidatePathEmptyOrBlankThrowsException() {
        try {
            securityUtils.validatePath("   ")
            fail("Expected SecurityException for empty path")
        } catch (e: SecurityException) {
            assertEquals("Path cannot be empty", e.message)
        }
    }

    @Test
    fun testValidatePathExceedsMaxLengthThrowsException() {
        val longPath = "/ext/" + "a".repeat(520)
        try {
            securityUtils.validatePath(longPath)
            fail("Expected SecurityException for oversized path")
        } catch (e: SecurityException) {
            assertEquals("Path exceeds maximum length", e.message)
        }
    }

    @Test
    fun testValidatePathTraversalAttemptsThrowException() {
        val traversalPaths = listOf(
            "/ext/../secret.txt",
            "/ext/foo/../../etc/passwd",
            "/ext/%2e%2e/test",
            "/ext/%252e/test"
        )

        for (path in traversalPaths) {
            try {
                securityUtils.validatePath(path)
                fail("Expected SecurityException for traversal path: $path")
            } catch (e: SecurityException) {
                assertTrue("Expected path traversal exception message, got: ${e.message}", e.message?.contains("traversal") == true)
            }
        }
    }

    @Test
    fun testValidatePathInvalidPrefixThrowsException() {
        try {
            securityUtils.validatePath("/data/local/tmp/file.txt")
            fail("Expected SecurityException for invalid path prefix")
        } catch (e: SecurityException) {
            assertEquals("Path must start with /ext/ or /int/", e.message)
        }
    }

    @Test
    fun testNormalizePath() {
        assertEquals("/ext/foo/bar", securityUtils.normalizePath("\\ext\\foo\\bar\\"))
        assertEquals("/ext/foo/bar", securityUtils.normalizePath("/ext//foo///bar"))
        assertEquals("/ext/foo/bar", securityUtils.normalizePath("/ext/./foo/bar"))
        assertEquals("/", securityUtils.normalizePath(""))
    }

    @Test
    fun testValidateContentSizeString() {
        securityUtils.validateContentSize("Hello, World!")
        val oversized = "a".repeat(SecurityUtils.MAX_CONTENT_SIZE + 1)
        try {
            securityUtils.validateContentSize(oversized)
            fail("Expected SecurityException for content size exceeding limit")
        } catch (e: SecurityException) {
            assertTrue(e.message?.contains("exceeds maximum size") == true)
        }
    }

    @Test
    fun testValidateContentSizeByteArray() {
        securityUtils.validateContentSize(ByteArray(100))
        val oversized = ByteArray(SecurityUtils.MAX_CONTENT_SIZE + 1)
        try {
            securityUtils.validateContentSize(oversized)
            fail("Expected SecurityException for ByteArray exceeding limit")
        } catch (e: SecurityException) {
            assertTrue(e.message?.contains("exceeds maximum size") == true)
        }
    }

    @Test
    fun testSanitizeFileName() {
        assertEquals("normal_file.txt", securityUtils.sanitizeFileName("normal_file.txt"))
        assertEquals("bad_name__.txt", securityUtils.sanitizeFileName("bad/name:?.txt"))
        assertEquals("path_traversal.txt", securityUtils.sanitizeFileName("path..traversal.txt"))
        assertEquals("bad__name.txt", securityUtils.sanitizeFileName("bad:..name.txt"))

        val longName = "a".repeat(300)
        assertEquals(255, securityUtils.sanitizeFileName(longName).length)
    }

    @Test
    fun testIsPathAllowed() {
        assertTrue(securityUtils.isPathAllowed("/ext/subGhz/door.sub", "/ext/subGhz"))
        assertFalse(securityUtils.isPathAllowed("/ext/other/door.sub", "/ext/subGhz"))
        assertFalse(securityUtils.isPathAllowed("/ext/subGhz/../other", "/ext/subGhz"))
    }

    @Test
    fun testRateLimiter() {
        val limiter = RateLimiter(maxRequests = 3, windowMs = 1000)
        assertTrue(limiter.tryAcquire())
        assertTrue(limiter.tryAcquire())
        assertTrue(limiter.tryAcquire())
        assertFalse(limiter.tryAcquire())
        assertEquals(0, limiter.remainingRequests())
    }

    @Test
    fun testInputValidator() {
        assertTrue(InputValidator.isSafeString("Hello world 123!"))
        assertFalse(InputValidator.isSafeString("Bad string\u0000"))

        assertTrue(InputValidator.isValidApiKey("sk-or-v1-abcdef1234567890"))
        assertFalse(InputValidator.isValidApiKey("short"))
        assertFalse(InputValidator.isValidApiKey("invalid key with spaces!"))

        assertEquals("&lt;script&gt;alert(1)&lt;/script&gt;", InputValidator.sanitizeForDisplay("<script>alert(1)</script>"))

        assertTrue(InputValidator.isValidJson("{\"key\": \"value\"}"))
        assertFalse(InputValidator.isValidJson("{invalid json}"))
    }
}
