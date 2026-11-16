package com.linkord.core

import org.junit.Assert.assertTrue
import org.junit.Test

class IdsTest {
    @Test
    fun comparesAsNumbers() {
        assertTrue(cmpId("10", "9") > 0)
        assertTrue(cmpId("18446744073709551615", "18446744073709551614") > 0)
        assertTrue(cmpId("5", "5") == 0)
    }
}
