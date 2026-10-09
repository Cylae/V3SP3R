package com.vesper.flipper.security

import org.junit.Assert.*
import org.junit.Before
import org.junit.Test

class SecurityUtilsTest {

    private lateinit var securityUtils: SecurityUtils

    @Before
    fun setUp() {
        securityUtils = SecurityUtils()
    }

    @Test
    fun testValidatePath_validPaths() {
        assertEquals("/ext/subghz/test.sub", securityUtils.validatePath("/ext/subghz/test.sub"))
        assertEquals("/int/settings.txt", securityUtils.validatePath("/int/settings.txt"))
        assertEquals("/ext", securityUtils.validatePath("/ext"))
        assertEquals("/int", securityUtils.validatePath("/int"))
    }

    @Test(expected = SecurityException::class)
    fun testValidatePath_nullByteInjection() {
        securityUtils.validatePath("/ext/subghz/test.sub\u0000.png")
    }

    @Test(expected = SecurityException::class)
    fun testValidatePath_emptyPath() {
        securityUtils.validatePath("   ")
    }

    @Test(expected = SecurityException::class)
    fun testValidatePath_invalidPrefix() {
        securityUtils.validatePath("/etc/passwd")
    }

    @Test(expected = SecurityException::class)
    fun testValidatePath_pathTraversal() {
        securityUtils.validatePath("/ext/foo/../../etc/passwd")
    }

    @Test
    fun testNormalizePath() {
        assertEquals("/ext/foo/bar", securityUtils.normalizePath("/ext//foo/./bar/"))
        assertEquals("/ext/foo", securityUtils.normalizePath("\\ext\\foo"))
    }

    @Test
    fun testSanitizeFileName() {
        assertEquals("test_file.txt", securityUtils.sanitizeFileName("test/file.txt"))
        assertEquals("test_file.txt", securityUtils.sanitizeFileName("test..file.txt"))
    }

    @Test
    fun testInputValidator_sanitizeForDisplay() {
        assertEquals("&lt;script&gt;alert(1)&lt;/script&gt;", InputValidator.sanitizeForDisplay("<script>alert(1)</script>"))
        assertEquals("foo &amp; bar", InputValidator.sanitizeForDisplay("foo & bar"))
    }
}
