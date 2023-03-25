using System.ComponentModel.DataAnnotations;

namespace Models.ViewModels
{
    public class LoginViewModel
    {
        [Required(ErrorMessage = "Enter name.")]
        [StringLength(50, MinimumLength = 3)]
        public string Name { get; set; }
        
        [Required(ErrorMessage = "Enter password.")]
        [StringLength(50, MinimumLength = 6)]
        public string Password { get; set; }
    }
}