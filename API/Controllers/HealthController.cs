using System.Net;
using System.Threading.Tasks;
using Microsoft.AspNetCore.Mvc;
using Microsoft.Extensions.Diagnostics.HealthChecks;

namespace API.Controllers;

[Route("[controller]")]
public class HealthController(HealthCheckService healthCheckService) : Controller
{
    /// <summary>
    ///  Get Health
    /// </summary>
    /// <remarks>Provides an indication about the health of the API</remarks>
    /// <response code="200">API is healthy</response>
    /// <response code="503">API is unhealthy or in degraded state</response>
    [HttpGet]
    [Route("")]
    [ProducesResponseType(typeof(HealthReport), (int)HttpStatusCode.OK)]
    public async Task<IActionResult> Get()
    {
        var report = await healthCheckService.CheckHealthAsync();

        return report.Status == HealthStatus.Healthy ? Ok(report) : StatusCode((int)HttpStatusCode.ServiceUnavailable, report);
    }
}